// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** Note palette: name -> background color */
  const COLORS = {
    yellow: '#FFF59D',
    pink: '#F8BBD0',
    blue: '#B3E5FC',
    green: '#C8E6C9',
    orange: '#FFE0B2',
  };
  const DEFAULT_COLOR = 'yellow';
  const DEFAULT_W = 200;
  const DEFAULT_H = 140;
  const MIN_W = 120;
  const MIN_H = 80;

  const boardEl = /** @type {HTMLElement} */ (document.getElementById('board'));
  const addBtn = /** @type {HTMLElement} */ (document.getElementById('add-note-btn'));
  const menuEl = /** @type {HTMLElement} */ (document.getElementById('context-menu'));

  /** @type {{version: number, notes: Array<{id:string,text:string,x:number,y:number,width:number,height:number,color:string,z:number}>}} */
  let board = { version: 1, notes: [] };
  let zCounter = 1;

  // ---------- Document sync ----------

  function serialize() {
    return JSON.stringify(board, null, 2) + '\n';
  }

  function pushToHost() {
    vscode.postMessage({ type: 'update', text: serialize() });
    vscode.setState({ text: serialize() });
  }

  /** @param {string} text */
  function loadFromText(text) {
    try {
      const parsed = text.trim() ? JSON.parse(text) : { version: 1, notes: [] };
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.notes)) {
        throw new Error('Invalid board format');
      }
      board = { version: parsed.version || 1, notes: [] };
      for (const raw of parsed.notes) {
        board.notes.push({
          id: typeof raw.id === 'string' ? raw.id : genId(),
          text: typeof raw.text === 'string' ? raw.text : '',
          x: Number.isFinite(raw.x) ? raw.x : 40,
          y: Number.isFinite(raw.y) ? raw.y : 40,
          width: Number.isFinite(raw.width) ? Math.max(MIN_W, raw.width) : DEFAULT_W,
          height: Number.isFinite(raw.height) ? Math.max(MIN_H, raw.height) : DEFAULT_H,
          color: raw.color in COLORS ? raw.color : DEFAULT_COLOR,
          z: Number.isFinite(raw.z) ? raw.z : ++zCounter,
        });
      }
      zCounter = board.notes.reduce((m, n) => Math.max(m, n.z), 1);
      render();
    } catch (err) {
      vscode.postMessage({
        type: 'error',
        message: 'Could not parse board file: ' + (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  function genId() {
    return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Rendering ----------

  function render() {
    // Remove notes that no longer exist; update or create the rest.
    const seen = new Set();
    for (const note of board.notes) {
      seen.add(note.id);
      let el = boardEl.querySelector(`[data-id="${note.id}"]`);
      if (!el) {
        el = createNoteElement(note.id);
        boardEl.appendChild(el);
      }
      syncNoteElement(/** @type {HTMLElement} */ (el), note);
    }
    for (const el of Array.from(boardEl.querySelectorAll('.note'))) {
      const id = /** @type {HTMLElement} */ (el).dataset.id;
      if (id && !seen.has(id)) {
        el.remove();
      }
    }
  }

  /** @param {string} id */
  function createNoteElement(id) {
    const el = document.createElement('div');
    el.className = 'note';
    el.dataset.id = id;

    const textEl = document.createElement('div');
    textEl.className = 'note-text';
    el.appendChild(textEl);

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    el.appendChild(handle);

    // --- interactions ---
    el.addEventListener('mousedown', (e) => onNoteMouseDown(e, el));
    handle.addEventListener('mousedown', (e) => onResizeMouseDown(e, el));
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startEditing(el);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showNoteMenu(e, id);
    });
    textEl.addEventListener('blur', () => stopEditing(el));
    textEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        textEl.blur();
      }
    });

    return el;
  }

  /**
   * @param {HTMLElement} el
   * @param {{id:string,text:string,x:number,y:number,width:number,height:number,color:string,z:number}} note
   */
  function syncNoteElement(el, note) {
    el.style.left = note.x + 'px';
    el.style.top = note.y + 'px';
    el.style.width = note.width + 'px';
    el.style.height = note.height + 'px';
    el.style.backgroundColor = COLORS[note.color] || COLORS[DEFAULT_COLOR];
    el.style.zIndex = String(note.z);
    const textEl = /** @type {HTMLElement} */ (el.querySelector('.note-text'));
    if (!el.classList.contains('editing') && textEl.dataset.rawText !== note.text) {
      textEl.innerHTML = renderMarkdown(note.text);
      textEl.dataset.rawText = note.text;
    }
  }

  /** @param {string} id */
  function getNote(id) {
    return board.notes.find((n) => n.id === id);
  }

  // ---------- Markdown rendering ----------
  // Minimal, dependency-free markdown -> sanitized HTML. Block-level markers
  // (#, >, -, digits) are matched against the raw line; the text content of
  // each block is HTML-escaped in renderInline before any tags are added, so
  // raw tags in note text can never reach the DOM as elements.

  /** @param {string} s */
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** @param {string} text raw (unescaped) inline text */
  function renderInline(text) {
    // Inline code and links are extracted to placeholder tokens first, so
    // their literal contents (snake_case identifiers, underscores in URLs)
    // never get mangled by the emphasis passes below. Sentinels use Unicode
    // Private Use Area code points, which never occur in normal note text.
    /** @type {string[]} */
    const tokens = [];
    /** @param {string} html */
    const store = (html) => {
      tokens.push(html);
      return `\uE000${tokens.length - 1}\uE001`;
    };

    let out = escapeHtml(text)
      .replace(/`([^`]+)`/g, (_m, code) => store(`<code>${code}</code>`))
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_m, label, url) => store(`<a href="${url}">${label}</a>`))
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a || b}</strong>`)
      .replace(/\*([^*]+)\*|_([^_]+)_/g, (_m, a, b) => `<em>${a || b}</em>`)
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    let prev;
    do {
      prev = out;
      out = out.replace(/\uE000(\d+)\uE001/g, (_m, i) => tokens[Number(i)]);
    } while (out !== prev);
    return out;
  }

  /** @param {string} raw */
  function renderMarkdown(raw) {
    const lines = raw.split('\n');
    const htmlParts = [];
    /** @type {{type: 'ul'|'ol', items: string[]} | null} */
    let list = null;
    const flushList = () => {
      if (list) {
        const tag = list.type;
        htmlParts.push(`<${tag}>${list.items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</${tag}>`);
        list = null;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^```/.test(line)) {
        flushList();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        htmlParts.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      const header = line.match(/^(#{1,6})\s+(.*)$/);
      if (header) {
        flushList();
        const level = header[1].length;
        htmlParts.push(`<h${level}>${renderInline(header[2])}</h${level}>`);
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushList();
        htmlParts.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
        continue;
      }

      const ul = line.match(/^[-*]\s+(.*)$/);
      if (ul) {
        if (!list || list.type !== 'ul') {
          flushList();
          list = { type: 'ul', items: [] };
        }
        list.items.push(ul[1]);
        continue;
      }

      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ol) {
        if (!list || list.type !== 'ol') {
          flushList();
          list = { type: 'ol', items: [] };
        }
        list.items.push(ol[1]);
        continue;
      }

      flushList();

      if (line.trim() === '') {
        continue;
      }

      htmlParts.push(`<p>${renderInline(line)}</p>`);
    }
    flushList();
    return htmlParts.join('');
  }

  // ---------- Note creation / deletion ----------

  /**
   * @param {number} x board coordinates
   * @param {number} y
   */
  function createNote(x, y) {
    hideMenu();
    const note = {
      id: genId(),
      text: '',
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: DEFAULT_W,
      height: DEFAULT_H,
      color: DEFAULT_COLOR,
      z: ++zCounter,
    };
    board.notes.push(note);
    render();
    pushToHost();
    const el = /** @type {HTMLElement} */ (boardEl.querySelector(`[data-id="${note.id}"]`));
    if (el) {
      startEditing(el); // new note is immediately editable
    }
  }

  function createNoteAtFreeSpot() {
    // Place near viewport center with a small cascade so notes don't stack exactly.
    const offset = (board.notes.length % 8) * 24;
    const x = boardEl.scrollLeft + Math.max(40, boardEl.clientWidth / 2 - DEFAULT_W / 2) + offset;
    const y = boardEl.scrollTop + Math.max(40, boardEl.clientHeight / 2 - DEFAULT_H / 2) + offset;
    createNote(x, y);
  }

  /** @param {string} id */
  function deleteNote(id) {
    board.notes = board.notes.filter((n) => n.id !== id);
    render();
    pushToHost();
  }

  function deleteAllNotes() {
    if (board.notes.length === 0) {
      return;
    }
    board.notes = [];
    render();
    pushToHost();
  }

  /**
   * @param {string} id
   * @param {string} color
   */
  function changeColor(id, color) {
    const note = getNote(id);
    if (note && color in COLORS) {
      note.color = color;
      render();
      pushToHost();
    }
  }

  // ---------- Editing ----------

  /** @param {HTMLElement} el */
  function startEditing(el) {
    const textEl = /** @type {HTMLElement} */ (el.querySelector('.note-text'));
    const note = getNote(el.dataset.id || '');
    el.classList.add('editing');
    // Switch from rendered markdown back to the raw source for editing.
    textEl.innerText = note ? note.text : '';
    textEl.contentEditable = 'true';
    textEl.focus();
    // put caret at the end
    const range = document.createRange();
    range.selectNodeContents(textEl);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /** @param {HTMLElement} el */
  function stopEditing(el) {
    if (!el.classList.contains('editing')) {
      return;
    }
    const textEl = /** @type {HTMLElement} */ (el.querySelector('.note-text'));
    el.classList.remove('editing');
    textEl.contentEditable = 'false';
    const note = getNote(el.dataset.id || '');
    if (note && note.text !== textEl.innerText) {
      note.text = textEl.innerText;
      pushToHost();
    }
    if (note) {
      textEl.innerHTML = renderMarkdown(note.text);
      textEl.dataset.rawText = note.text;
    }
  }

  // ---------- Drag ----------

  /**
   * @param {MouseEvent} e
   * @param {HTMLElement} el
   */
  function onNoteMouseDown(e, el) {
    if (e.button !== 0 || el.classList.contains('editing')) {
      return;
    }
    if (/** @type {HTMLElement} */ (e.target).classList.contains('resize-handle')) {
      return;
    }
    e.preventDefault();
    hideMenu();

    const note = getNote(el.dataset.id || '');
    if (!note) {
      return;
    }
    // Bring to front.
    note.z = ++zCounter;
    el.style.zIndex = String(note.z);

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = note.x;
    const origY = note.y;
    let moved = false;

    const onMove = (/** @type {MouseEvent} */ ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) {
        moved = true;
        el.classList.add('dragging');
      }
      if (moved) {
        note.x = Math.max(0, origX + dx);
        note.y = Math.max(0, origY + dy);
        el.style.left = note.x + 'px';
        el.style.top = note.y + 'px';
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      el.classList.remove('dragging');
      pushToHost(); // persists position and/or z-order bump
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ---------- Resize ----------

  /**
   * @param {MouseEvent} e
   * @param {HTMLElement} el
   */
  function onResizeMouseDown(e, el) {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    hideMenu();

    const note = getNote(el.dataset.id || '');
    if (!note) {
      return;
    }
    el.classList.add('resizing');

    const startX = e.clientX;
    const startY = e.clientY;
    const origW = note.width;
    const origH = note.height;

    const onMove = (/** @type {MouseEvent} */ ev) => {
      note.width = Math.max(MIN_W, origW + (ev.clientX - startX));
      note.height = Math.max(MIN_H, origH + (ev.clientY - startY));
      el.style.width = note.width + 'px';
      el.style.height = note.height + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      el.classList.remove('resizing');
      pushToHost();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ---------- Context menus ----------

  function hideMenu() {
    menuEl.hidden = true;
    menuEl.innerHTML = '';
  }

  /**
   * @param {MouseEvent} e
   * @param {Array<{label?:string,separator?:boolean,action?:() => void,colors?:boolean,noteId?:string}>} items
   */
  function showMenu(e, items) {
    menuEl.innerHTML = '';
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'menu-separator';
        menuEl.appendChild(sep);
        continue;
      }
      const itemEl = document.createElement('div');
      itemEl.className = 'menu-item';
      const label = document.createElement('span');
      label.textContent = item.label || '';
      itemEl.appendChild(label);

      if (item.colors && item.noteId) {
        const arrow = document.createElement('span');
        arrow.className = 'submenu-arrow';
        arrow.textContent = '▶';
        itemEl.appendChild(arrow);

        const submenu = document.createElement('div');
        submenu.className = 'submenu';
        for (const [name, hex] of Object.entries(COLORS)) {
          const swatch = document.createElement('div');
          swatch.className = 'color-swatch';
          swatch.title = name;
          swatch.style.backgroundColor = hex;
          swatch.addEventListener('click', (ev) => {
            ev.stopPropagation();
            changeColor(/** @type {string} */ (item.noteId), name);
            hideMenu();
          });
          submenu.appendChild(swatch);
        }
        itemEl.appendChild(submenu);
      } else if (item.action) {
        itemEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          hideMenu();
          item.action && item.action();
        });
      }
      menuEl.appendChild(itemEl);
    }

    menuEl.hidden = false;
    // Position, keeping the menu inside the viewport.
    const rect = menuEl.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
    menuEl.style.left = Math.max(0, x) + 'px';
    menuEl.style.top = Math.max(0, y) + 'px';
  }

  /**
   * @param {MouseEvent} e
   * @param {string} noteId
   */
  function showNoteMenu(e, noteId) {
    showMenu(e, [
      { label: 'Delete note', action: () => deleteNote(noteId) },
      { label: 'Change colors…', colors: true, noteId },
    ]);
  }

  /** @param {MouseEvent} e */
  function showBoardMenu(e) {
    const x = e.clientX + boardEl.scrollLeft;
    const y = e.clientY + boardEl.scrollTop;
    showMenu(e, [
      { label: 'Create a note', action: () => createNote(x, y) },
      { separator: true },
      { label: 'Delete all notes', action: () => deleteAllNotes() },
    ]);
  }

  // ---------- Global listeners ----------

  addBtn.addEventListener('click', () => createNoteAtFreeSpot());

  boardEl.addEventListener('contextmenu', (e) => {
    // Only for empty board area (notes handle their own contextmenu).
    if (e.target === boardEl) {
      e.preventDefault();
      showBoardMenu(e);
    }
  });

  boardEl.addEventListener('mousedown', (e) => {
    if (e.target === boardEl) {
      hideMenu();
      // Clicking empty space commits any in-progress edit.
      const editing = boardEl.querySelector('.note.editing');
      if (editing) {
        stopEditing(/** @type {HTMLElement} */ (editing));
      }
    }
  });

  // Rendered markdown links can't navigate inside the webview (CSP + iframe
  // sandboxing), so hand them off to the extension host to open externally.
  boardEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const anchor = target.closest ? target.closest('a') : null;
    if (!anchor) {
      return;
    }
    const noteEl = anchor.closest('.note');
    if (noteEl && noteEl.classList.contains('editing')) {
      return;
    }
    e.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) {
      vscode.postMessage({ type: 'openLink', url: href });
    }
  });

  window.addEventListener('blur', hideMenu);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'load') {
      loadFromText(message.text);
      vscode.setState({ text: message.text });
    }
  });

  // Restore instantly from cached state (e.g. tab re-shown), then ask the host
  // for the authoritative document.
  const previous = vscode.getState();
  if (previous && typeof previous.text === 'string') {
    loadFromText(previous.text);
  }
  vscode.postMessage({ type: 'ready' });
})();
