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
  const exportBtn = /** @type {HTMLElement} */ (document.getElementById('export-png-btn'));
  const menuEl = /** @type {HTMLElement} */ (document.getElementById('context-menu'));

  /** @type {{version: number, notes: Array<{id:string,text:string,x:number,y:number,width:number,height:number,color:string,z:number,createdAt:number,updatedAt:number|null}>}} */
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
        const id = typeof raw.id === 'string' ? raw.id : genId();
        board.notes.push({
          id,
          text: typeof raw.text === 'string' ? raw.text : '',
          x: Number.isFinite(raw.x) ? raw.x : 40,
          y: Number.isFinite(raw.y) ? raw.y : 40,
          width: Number.isFinite(raw.width) ? Math.max(MIN_W, raw.width) : DEFAULT_W,
          height: Number.isFinite(raw.height) ? Math.max(MIN_H, raw.height) : DEFAULT_H,
          color: raw.color in COLORS ? raw.color : DEFAULT_COLOR,
          z: Number.isFinite(raw.z) ? raw.z : ++zCounter,
          // Notes saved before this field existed don't have a createdAt; the
          // id itself embeds its creation time (see genId), so fall back to that.
          createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : deriveCreatedAtFromId(id) ?? Date.now(),
          updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
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

  /** @param {string} id */
  function deriveCreatedAtFromId(id) {
    const m = /^n-([0-9a-z]+)-/.exec(id);
    const ts = m ? parseInt(m[1], 36) : NaN;
    return Number.isFinite(ts) ? ts : null;
  }

  /** @param {number} ts */
  function formatDate(ts) {
    if (!Number.isFinite(ts)) {
      return '';
    }
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

    const header = document.createElement('div');
    header.className = 'note-header';
    const dateEl = document.createElement('span');
    dateEl.className = 'note-date';
    header.appendChild(dateEl);
    const updatedEl = document.createElement('span');
    updatedEl.className = 'note-updated-date';
    header.appendChild(updatedEl);
    el.appendChild(header);

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
      if (el.classList.contains('editing')) {
        // Already editing: let the native double-click-to-select-word
        // behavior happen instead of resetting the caret to the end.
        return;
      }
      if (/** @type {HTMLElement} */ (e.target).closest('.note-header')) {
        return;
      }
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
   * @param {{id:string,text:string,x:number,y:number,width:number,height:number,color:string,z:number,createdAt:number,updatedAt:number|null}} note
   */
  function syncNoteElement(el, note) {
    el.style.left = note.x + 'px';
    el.style.top = note.y + 'px';
    el.style.width = note.width + 'px';
    el.style.height = note.height + 'px';
    el.style.backgroundColor = COLORS[note.color] || COLORS[DEFAULT_COLOR];
    el.style.zIndex = String(note.z);
    const dateEl = /** @type {HTMLElement} */ (el.querySelector('.note-date'));
    dateEl.textContent = formatDate(note.createdAt);
    const updatedEl = /** @type {HTMLElement} */ (el.querySelector('.note-updated-date'));
    updatedEl.textContent = Number.isFinite(note.updatedAt) ? ` · ${formatDate(/** @type {number} */ (note.updatedAt))}` : '';
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

  /** @param {string} line */
  function matchListItem(line) {
    const m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (!m) {
      return null;
    }
    return { indent: m[1].length, type: /** @type {'ul'|'ol'} */ (m[2] === '-' || m[2] === '*' ? 'ul' : 'ol'), content: m[3] };
  }

  /**
   * Consumes a run of list-item lines starting at index `i` whose indent is
   * >= baseIndent. Items indented deeper than the current run nest as a
   * sub-list inside the preceding <li>, so e.g. two extra leading spaces
   * produce one extra level of nesting.
   * @param {string[]} lines
   * @param {number} i
   * @param {number} baseIndent
   */
  function parseList(lines, i, baseIndent) {
    /** @type {Array<{content: string, children: string}>} */
    const items = [];
    /** @type {'ul'|'ol'|null} */
    let type = null;
    while (i < lines.length) {
      const item = matchListItem(lines[i]);
      if (!item || item.indent < baseIndent) {
        break;
      }
      if (item.indent > baseIndent) {
        if (items.length === 0) {
          break;
        }
        const child = parseList(lines, i, item.indent);
        items[items.length - 1].children += child.html;
        i = child.next;
        continue;
      }
      if (type && item.type !== type) {
        break;
      }
      type = item.type;
      items.push({ content: item.content, children: '' });
      i++;
    }
    const tag = type || 'ul';
    const html = `<${tag}>${items.map((it) => `<li>${renderInline(it.content)}${it.children}</li>`).join('')}</${tag}>`;
    return { html, next: i };
  }

  /** @param {string} raw */
  function renderMarkdown(raw) {
    const lines = raw.split('\n');
    const htmlParts = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^```/.test(line)) {
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
        const level = header[1].length;
        htmlParts.push(`<h${level}>${renderInline(header[2])}</h${level}>`);
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        htmlParts.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
        continue;
      }

      const listItem = matchListItem(line);
      if (listItem) {
        const list = parseList(lines, i, listItem.indent);
        htmlParts.push(list.html);
        i = list.next - 1;
        continue;
      }

      if (line.trim() === '') {
        continue;
      }

      htmlParts.push(`<p>${renderInline(line)}</p>`);
    }
    return htmlParts.join('');
  }

  // ---------- Export ----------

  function exportBoardAsPng() {
    // Clicking the button doesn't blur a note mid-edit, so commit it first
    // or the export would capture stale (pre-edit) text.
    const editing = boardEl.querySelector('.note.editing');
    if (editing) {
      stopEditing(/** @type {HTMLElement} */ (editing));
    }

    if (board.notes.length === 0) {
      vscode.postMessage({ type: 'info', message: 'Nothing to export — add a note first.' });
      return;
    }

    const PADDING = 40;
    const minX = Math.min(...board.notes.map((n) => n.x));
    const minY = Math.min(...board.notes.map((n) => n.y));
    const maxX = Math.max(...board.notes.map((n) => n.x + n.width));
    const maxY = Math.max(...board.notes.map((n) => n.y + n.height));
    const width = maxX - minX + PADDING * 2;
    const height = maxY - minY + PADDING * 2;

    // Oversample for a crisp export, but stay under Chromium's max canvas
    // dimension (~16384px) so toDataURL doesn't silently return a blank image.
    const MAX_DIM = 16384;
    const scale = Math.max(0.1, Math.min(2, MAX_DIM / width, MAX_DIM / height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.scale(scale, scale);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const sampleTextEl = boardEl.querySelector('.note-text');
    const fontFamily = sampleTextEl ? getComputedStyle(sampleTextEl).fontFamily : 'sans-serif';

    const sorted = [...board.notes].sort((a, b) => a.z - b.z);
    for (const note of sorted) {
      drawNote(ctx, note, minX - PADDING, minY - PADDING, fontFamily);
    }

    const dataUrl = canvas.toDataURL('image/png');
    vscode.postMessage({ type: 'exportPng', dataUrl });
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number,width:number,height:number,color:string,text:string,createdAt:number,updatedAt:number|null}} note
   * @param {number} offsetX
   * @param {number} offsetY
   * @param {string} fontFamily
   */
  function drawNote(ctx, note, offsetX, offsetY, fontFamily) {
    const x = note.x - offsetX;
    const y = note.y - offsetY;
    const { width, height } = note;
    const radius = 6;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = COLORS[note.color] || COLORS[DEFAULT_COLOR];
    roundRectPath(ctx, x, y, width, height, radius);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, x, y, width, height, radius);
    ctx.clip();

    ctx.fillStyle = 'rgba(31, 35, 40, 0.6)';
    ctx.font = `10px ${fontFamily}`;
    ctx.textBaseline = 'top';
    let dateLine = formatDate(note.createdAt);
    if (Number.isFinite(note.updatedAt)) {
      dateLine += ' · ' + formatDate(/** @type {number} */ (note.updatedAt));
    }
    ctx.fillText(dateLine, x + 12, y + 6, width - 24);

    ctx.fillStyle = '#1f2328';
    ctx.font = `13px ${fontFamily}`;
    wrapText(ctx, toPlainText(note.text), x + 12, y + 26, width - 24, height - 36, 19);
    ctx.restore();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} r
   */
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Word-wraps text (respecting existing newlines) inside a box, clipping
   * once it would overflow maxHeight.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {number} x
   * @param {number} y
   * @param {number} maxWidth
   * @param {number} maxHeight
   * @param {number} lineHeight
   */
  function wrapText(ctx, text, x, y, maxWidth, maxHeight, lineHeight) {
    let curY = y;
    for (const paragraph of text.split('\n')) {
      const indent = /^ */.exec(paragraph)[0];
      const indentWidth = ctx.measureText(indent).width;
      const lineX = x + indentWidth;
      const lineMaxWidth = maxWidth - indentWidth;
      const words = paragraph.slice(indent.length).split(' ');
      let line = '';
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (line && ctx.measureText(test).width > lineMaxWidth) {
          if (curY + lineHeight > y + maxHeight) {
            return;
          }
          ctx.fillText(line, lineX, curY);
          curY += lineHeight;
          line = word;
        } else {
          line = test;
        }
      }
      if (curY + lineHeight > y + maxHeight) {
        return;
      }
      ctx.fillText(line, lineX, curY);
      curY += lineHeight;
    }
  }

  /**
   * Strips markdown syntax down to plain text for the canvas export, which
   * can't render the HTML tags renderMarkdown produces. Mirrors the block
   * markers handled by renderMarkdown and the inline patterns in
   * renderInline, minus the HTML wrapping.
   * @param {string} raw
   */
  function toPlainText(raw) {
    const lines = raw.split('\n');
    const out = [];
    let inFence = false;
    for (let line of lines) {
      if (/^```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        out.push(line);
        continue;
      }
      line = line.replace(/^(#{1,6})\s+/, '');
      line = line.replace(/^>\s?/, '');
      const listItem = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (listItem) {
        line = listItem[1] + '• ' + listItem[3];
      }
      out.push(stripInline(line));
    }
    return out.join('\n');
  }

  /** @param {string} text */
  function stripInline(text) {
    /** @type {string[]} */
    const tokens = [];
    /** @param {string} s */
    const store = (s) => {
      tokens.push(s);
      return `${tokens.length - 1}`;
    };

    let out = text
      .replace(/`([^`]+)`/g, (_m, code) => store(code))
      .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^\s)]+\)/g, (_m, label) => store(label))
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => a || b)
      .replace(/\*([^*]+)\*|_([^_]+)_/g, (_m, a, b) => a || b)
      .replace(/~~([^~]+)~~/g, '$1');

    let prev;
    do {
      prev = out;
      out = out.replace(/(\d+)/g, (_m, i) => tokens[Number(i)]);
    } while (out !== prev);
    return out;
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
      createdAt: Date.now(),
      updatedAt: null,
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
    const note = getNote(el.dataset.id || '');
    // Read innerText while still in 'editing' layout (white-space: pre-wrap):
    // once the class is removed, white-space reverts to 'normal' and the
    // browser collapses leading/repeated whitespace before innerText sees it.
    const newText = textEl.innerText;
    el.classList.remove('editing');
    textEl.contentEditable = 'false';
    if (note && note.text !== newText) {
      note.text = newText;
      note.updatedAt = Date.now();
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
  exportBtn.addEventListener('click', () => exportBoardAsPng());

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
