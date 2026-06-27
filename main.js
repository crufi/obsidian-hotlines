// ╔════════════════════════════════════════════════════════════════════════════════════════════════
// ║ Hotlines plugin for Obsidian
// ║ by Steve Crutchfield
// ╚════════════════════════════════════════════════════════════════════════════════════════════════

const obsidian = require('obsidian');
const cmView = require('@codemirror/view');
const cmState = require('@codemirror/state');

const LAYOUT_STYLE = 'padding: 2px 6px; border-radius: 8px; border: 1px solid #606060;';

// Small left inset for highlighted lines in Live Preview, so text isn't flush
// against the editor edge. Applied ONLY to plain lines — list/quote/indented
// lines are skipped because left padding there fights Obsidian's hanging
// indent and reintroduces the cursor-jump bug.
const EDITOR_INSET = 6;

const DEFAULT_RULES = [
  {
    id: crypto.randomUUID(),
    name: 'NOTE',
    pattern: '\\bNOTE\\b',
    flags: '',
    background: '#48cc24',
    textColor: '#ffffff',
    bold: true,
    italic: false,
    css: 'background: #48cc24; color: #ffffff; font-weight: bold; padding: 2px 6px; border-radius: 8px; border: 1px solid #606060;',
    enabled: true,
  },
  {
    id: crypto.randomUUID(),
    name: 'PROBLEM',
    pattern: '\\b(PROBLEM|BUG)\\b',
    flags: '',
    background: '#ff4015',
    textColor: '#fffa5c',
    bold: true,
    italic: false,
    css: 'background: #ff4015; color: #fffa5c; font-weight: bold; padding: 2px 6px; border-radius: 8px; border: 1px solid #606060;',
    enabled: true,
  },
  {
    id: crypto.randomUUID(),
    name: 'TODO',
    pattern: '\\bTODO\\b',
    flags: '',
    background: '#734dff',
    textColor: '#ffffff',
    bold: true,
    italic: false,
    css: 'background: #734dff; color: #ffffff; font-weight: bold; padding: 2px 6px; border-radius: 8px; border: 1px solid #606060;',
    enabled: true,
  },
  {
    id: crypto.randomUUID(),
    name: 'CONTINUE',
    pattern: '\\bCONTINUE\\b',
    flags: '',
    background: '#1f5fea',
    textColor: '#ffffff',
    bold: true,
    italic: false,
    css: 'background: #1f5fea; color: #ffffff; font-weight: bold; padding: 2px 6px; border-radius: 8px; border: 1px solid #606060;',
    enabled: true,
  },
];

function cssFromControls(rule) {
  const parts = [];
  if (rule.background) parts.push(`background: ${rule.background}`);
  if (rule.textColor) parts.push(`color: ${rule.textColor}`);
  if (rule.bold) parts.push('font-weight: bold');
  if (rule.italic) parts.push('font-style: italic');
  parts.push(LAYOUT_STYLE);
  return parts.join('; ');
}

// Parse a CSS declaration string into ordered [prop, value] pairs.
function parseDeclarations(css) {
  return (css || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(decl => {
      const i = decl.indexOf(':');
      return i === -1
        ? [decl.toLowerCase(), '']
        : [decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim()];
    });
}

// Update a single property in a CSS string, leaving every other declaration
// (border-radius, padding, custom rules…) untouched. value === null removes it.
function setDeclaration(css, prop, value) {
  prop = prop.toLowerCase();
  const decls = parseDeclarations(css);
  const idx = decls.findIndex(([p]) => p === prop);
  if (value == null) {
    if (idx !== -1) decls.splice(idx, 1);
  } else if (idx !== -1) {
    decls[idx][1] = value;
  } else {
    decls.push([prop, value]);
  }
  return decls.map(([p, v]) => (v ? `${p}: ${v}` : p)).join('; ');
}

function fullStyle(rule) {
  return rule.css || cssFromControls(rule);
}

// Editor (Live Preview) style: same colors/weight as reading mode, but with
// any layout-shifting declarations removed. Inline padding/margin on a
// `.cm-line` overrides Obsidian's list hanging-indent (padding-inline-start),
// which collapses bullet indentation and causes the cursor-on/off "jump".
// Dropping them leaves a clean full-row background with bullets intact on top.
function stripLayout(css) {
  return css
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !/^(padding|margin)\b/i.test(s.split(':')[0].trim()))
    .join('; ');
}

function editorStyle(rule) {
  // `background` shorthand can wipe theme background layers; prefer the
  // explicit `background-color` so we only paint the row fill.
  return stripLayout(fullStyle(rule)).replace(/\bbackground\s*:/g, 'background-color:');
}

const BLOCK_TAGS = ['p', 'li', 'div', 'blockquote'];

// Nearest block-level ancestor of a (text) node, bounded by `root`.
function nearestBlock(node, root) {
  let el = node.parentElement;
  while (el && el !== root && !BLOCK_TAGS.includes(el.tagName.toLowerCase())) {
    el = el.parentElement;
  }
  return el && el !== root ? el : node.parentElement;
}

// Propagate text color / weight onto nested inline elements (bold, links, etc.)
// so they don't keep the theme's default color over our background.
function colorChildren(container, rule) {
  if (!rule.textColor) return;
  container.querySelectorAll('*').forEach(c => {
    c.style.color = rule.textColor;
    if (rule.bold) c.style.fontWeight = 'bold';
    if (rule.italic) c.style.fontStyle = 'italic';
  });
}

// In a multi-line block (callout body, or a paragraph with soft line breaks)
// the lines live in ONE element separated by <br>. Wrap just the line that
// contains `node` in a block-level span so only that row is highlighted. The
// bracketing <br>s are dropped because a display:block span already forces a
// line break before and after itself.
function wrapLineSegment(block, node, rule) {
  // Climb to the block's direct child that contains the matched text node.
  let top = node;
  while (top.parentNode && top.parentNode !== block) top = top.parentNode;
  if (top.parentNode !== block) return;
  if (top.nodeType === 1 && top.classList.contains('hotline-segment')) return; // already wrapped

  // Expand to the run of siblings bounded by <br> (one visual line).
  let first = top;
  while (first.previousSibling && first.previousSibling.nodeName !== 'BR') {
    first = first.previousSibling;
  }
  const seg = [];
  for (let n = first; n && n.nodeName !== 'BR'; n = n.nextSibling) seg.push(n);
  if (!seg.length) return;

  const before = first.previousSibling;            // a <br> or null
  const after = seg[seg.length - 1].nextSibling;   // a <br> or null

  const span = document.createElement('span');
  span.className = 'hotline-segment';
  span.setAttribute('style', 'display: block; ' + rule.compiledStyle);
  block.insertBefore(span, seg[0]);
  seg.forEach(s => span.appendChild(s));
  colorChildren(span, rule);

  if (before && before.nodeName === 'BR') before.remove();
  if (after && after.nodeName === 'BR') after.remove();
}

// A plain (non-tokenized) code block renders every line as ONE newline-
// separated text node inside <code>. Styling that node backgrounds all of its
// lines. Split on \n and give only the matching lines a full-row highlight.
// Matching lines become display:block spans (no horizontal padding, so the
// monospace columns stay aligned); the block forces its own line break, so the
// surrounding "\n" separators are dropped around it.
function highlightCodeNode(textNode, rules) {
  const lines = textNode.textContent.split('\n');
  if (!lines.some(ln => rules.some(r => r.regex.test(ln)))) return;

  const frag = document.createDocumentFragment();
  let prevWasBlock = true; // no leading "\n" needed before the first line
  lines.forEach(ln => {
    const rule = ln ? rules.find(r => r.regex.test(ln)) : null;
    if (rule) {
      const span = document.createElement('span');
      span.className = 'hotline-segment';
      span.setAttribute('style', 'display: block; ' + rule.editorStyle);
      span.textContent = ln;
      colorChildren(span, rule);
      frag.appendChild(span);
      prevWasBlock = true;
    } else {
      if (!prevWasBlock) frag.appendChild(document.createTextNode('\n'));
      frag.appendChild(document.createTextNode(ln));
      prevWasBlock = false;
    }
  });
  textNode.parentNode.replaceChild(frag, textNode);
}

// Highlight a list row without disturbing Obsidian's bullet layout. Three
// things matter, all learned from inspecting the live DOM:
//  1. Bold/italic must go on a wrapper around the TEXT, never on the <li>:
//     Obsidian sizes the hanging-indent (the <li>'s margin-inline-start) from
//     text metrics, so bolding the <li> widens that indent and shifts the whole
//     row out of line with its siblings. The bullet (.list-bullet) is left
//     untouched for the same reason.
//  2. The fill is a separate absolutely-positioned layer behind the content, so
//     nothing in the flow moves and bullets/text stay put. It's extended left
//     to the list edge so the row spans full width with the bullet sitting on it.
//  3. Obsidian applies that indent margin AFTER this post-processor runs, so the
//     left extension is measured on a later frame (retrying until it appears).
function highlightListItem(block, rule) {
  const bullet = block.querySelector('.list-bullet');

  const textWrap = document.createElement('span');
  textWrap.className = 'hotline-text';
  if (rule.bold) textWrap.style.fontWeight = 'bold';
  if (rule.italic) textWrap.style.fontStyle = 'italic';
  for (const node of [...block.childNodes]) {
    if (node !== bullet) textWrap.appendChild(node);
  }
  block.appendChild(textWrap);

  const bg = document.createElement('div');
  bg.className = 'hotline-bg';
  bg.setAttribute('style',
    'position:absolute; z-index:-1; top:0; bottom:0; right:0; left:0;' +
    ` background:${rule.background || '#2563eb'}; border-radius:3px`);
  block.appendChild(bg);

  block.style.position = 'relative';
  block.style.isolation = 'isolate'; // contain the z-index:-1 layer
  if (rule.textColor) {
    block.style.color = rule.textColor; // covers bullet + text via inheritance
    textWrap.querySelectorAll('*').forEach(c => { c.style.color = rule.textColor; });
  }

  let tries = 0;
  const place = () => {
    const pad = parseFloat(getComputedStyle(block).marginInlineStart) || 0;
    if (pad) bg.style.left = `-${pad}px`;
    else if (tries++ < 12) requestAnimationFrame(place);
  };
  requestAnimationFrame(place);
}

function migrateRule(rule) {
  if ('background' in rule && 'css' in rule) return rule;
  return {
    id: rule.id || crypto.randomUUID(),
    name: rule.name || 'Untitled',
    pattern: rule.pattern || '',
    flags: rule.flags || '',
    background: '#2563eb',
    textColor: '#ffffff',
    bold: true,
    italic: false,
    css: '',
    enabled: rule.enabled !== false,
  };
}

class HotlinesPlugin extends obsidian.Plugin {
  async onload() {
    console.log('Hotlines: loaded');

    // In Live Preview, Obsidian wraps some content (e.g. leading-tab/indented
    // lines) in child elements that carry their own background and text color —
    // an opaque "pill" that paints over our line highlight. Neutralize those
    // backgrounds/colors, but only inside our highlighted lines, so every
    // highlight reads as a clean full-row regardless of inner rendering.
    this._styleEl = document.createElement('style');
    // Scoped OUT of list lines: on a list line this would override how Obsidian
    // hides the raw "-"/"*" list marker, making the dash reappear next to the
    // rendered bullet. Lists don't have the opaque-pill problem anyway.
    this._styleEl.textContent = `
.cm-line.hotline-line:not(.HyperMD-list-line) * { background-color: transparent !important; color: inherit !important; border-color: transparent !important; }
.hotline-swatch::-webkit-color-swatch-wrapper { padding: 0; }
.hotline-swatch::-webkit-color-swatch { border: none; border-radius: 5px; }
.hotline-group { background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 10px; padding: 0 14px; margin-bottom: 12px; }
.hotline-group-header { font-weight: 600; font-size: 0.9em; color: var(--text-muted); padding: 10px 0 0; }
.hotline-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 0; min-height: 40px; }
.hotline-row + .hotline-row { border-top: 1px solid var(--background-modifier-border); }
.hotline-row-label { font-weight: 500; flex-shrink: 0; }
.hotline-row-control { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.hotline-row-control.wide { flex: 1; }
.hotline-row-control.wide input { width: 100%; }
`;
    document.head.appendChild(this._styleEl);

    await this.loadSettings();
    this.addSettingTab(new HotlinesSettingTab(this.app, this));

    this._extensionArray = [];
    this.registerEditorExtension(this._extensionArray);
    this.rebuildViewPlugin();

    this.registerMarkdownPostProcessor((el) => {
      const rules = this.getActiveRules();
      if (!rules.length) return;

      // Collect matches first, then mutate — wrapping rewrites the DOM the
      // TreeWalker is traversing.
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const matches = [];
      const codeNodes = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement && node.parentElement.closest('.hotline-segment')) continue;
        const text = node.textContent;
        // A newline inside a single text node means preformatted content
        // (code block) — soft breaks in prose are <br>, hard breaks are
        // separate elements. Handle these per-line, not as a whole block.
        if (text.indexOf('\n') !== -1) {
          if (rules.some(r => r.regex.test(text))) codeNodes.push(node);
          continue;
        }
        // Inside a tokenized (language-tagged) code block each line is shredded
        // into syntax-token spans, so a match rarely lands whole in one text
        // node. Skip the prose/block path there rather than half-highlighting a
        // single token. Plain code blocks are handled above via their \n node.
        if (node.parentElement && node.parentElement.closest('pre')) continue;
        for (const rule of rules) {
          if (rule.regex.test(text)) { matches.push({ node, rule }); break; }
        }
      }

      for (const node of codeNodes) highlightCodeNode(node, rules);

      for (const { node, rule } of matches) {
        if (!node.parentElement) continue; // detached by an earlier wrap
        const block = nearestBlock(node, el);
        if (!block) continue;

        if (block.querySelector('br')) {
          // Multi-line block (callout / soft-wrapped paragraph): one row only.
          wrapLineSegment(block, node, rule);
        } else if (!block.dataset.hotline) {
          if (block.tagName === 'LI') {
            highlightListItem(block, rule);
          } else {
            // Single logical line: highlight the whole block.
            block.setAttribute('style', rule.compiledStyle);
            colorChildren(block, rule);
          }
          block.dataset.hotline = '1';
        }
      }
    });
  }

  async loadSettings() {
    const data = await this.loadData();
    if (data && data.rules) data.rules = data.rules.map(migrateRule);
    this.settings = { rules: DEFAULT_RULES, ...(data || {}) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getActiveRules() {
    return this.settings.rules
      .filter(r => r.enabled && r.pattern)
      .map(r => {
        try {
          // Drop the global flag: we call regex.test() repeatedly per line,
          // and a sticky lastIndex would make those calls miss.
          const flags = (r.flags || '').replace(/g/g, '');
          return { ...r, regex: new RegExp(r.pattern, flags), compiledStyle: fullStyle(r), editorStyle: editorStyle(r) };
        } catch { return null; }
      })
      .filter(Boolean);
  }

  rebuildViewPlugin() {
    const plugin = this;
    const ext = cmView.ViewPlugin.fromClass(
      class {
        constructor(view) { this.decorations = this.build(view); }
        update(update) {
          if (update.docChanged || update.viewportChanged)
            this.decorations = this.build(update.view);
        }
        build(view) {
          const rules = plugin.getActiveRules();
          const decos = [];
          if (!rules.length) return cmView.Decoration.set(decos, true);

          const doc = view.state.doc;
          const lastVisible = view.visibleRanges.length
            ? doc.lineAt(view.visibleRanges[view.visibleRanges.length - 1].to).number
            : 0;
          // Flag lines inside fenced code blocks. Code highlights must align
          // with reading mode (no inset) and fenced + indented code blocks must
          // look identical, so the plain-line inset is suppressed inside fences.
          const inFenced = new Uint8Array(lastVisible + 1);
          let fenced = false;
          for (let i = 1; i <= lastVisible; i++) {
            if (/^\s*(```|~~~)/.test(doc.line(i).text)) { inFenced[i] = 1; fenced = !fenced; }
            else inFenced[i] = fenced ? 1 : 0;
          }

          for (const { from, to } of view.visibleRanges) {
            for (let pos = from; pos <= to; ) {
              const line = view.state.doc.lineAt(pos);
              for (const rule of rules) {
                if (rule.regex.test(line.text)) {
                  // Inset plain prose lines only; code, list, quote and indented
                  // lines keep their natural left edge (see EDITOR_INSET).
                  const inCode = inFenced[line.number] === 1;
                  const plain = !inCode && /^\S/.test(line.text) && !/^([-*+]\s|\d+[.)]\s|>)/.test(line.text);
                  const style = plain
                    ? `${rule.editorStyle}; padding-left: ${EDITOR_INSET}px`
                    : rule.editorStyle;
                  decos.push(cmView.Decoration.line({ attributes: { style, class: 'hotline-line' } }).range(line.from));
                  break;
                }
              }
              pos = line.to + 1;
            }
          }
          return cmView.Decoration.set(decos, true);
        }
      },
      { decorations: v => v.decorations }
    );
    this._extensionArray.length = 0;
    this._extensionArray.push(ext);
    this.app.workspace.updateOptions();
  }

  refreshEditors() { this.rebuildViewPlugin(); }
  onunload() {
    if (this._styleEl) this._styleEl.remove();
    console.log('Hotlines: unloaded');
  }
}

// ╔════════════════════════════════════════════════════════════════════════════════════════════════
// ║ Settings Tab
// ╚════════════════════════════════════════════════════════════════════════════════════════════════

const EXAMPLE_CSS = `/* Copy any of these into the CSS field: */
background: #2563eb;
color: #ffffff;
font-weight: bold;
font-style: italic;
padding: 2px 4px;
border-radius: 3px;
border-left: 4px solid #fbbf24;
text-decoration: underline;
opacity: 0.9;`;

function colorSwatch(parent, value, onChange) {
  const input = parent.createEl('input', { type: 'color' });
  input.className = 'hotline-swatch';
  input.value = value;
  // appearance:none + the ::-webkit-color-swatch rules (injected in onload) make
  // the color fill a clean rounded rect instead of iOS's default pill shape.
  input.style.cssText = '-webkit-appearance:none; appearance:none; width:40px; height:28px; padding:0; cursor:pointer; border:1px solid var(--background-modifier-border); border-radius:6px; overflow:hidden; flex-shrink:0;';
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

class HotlinesSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Hotlines' });
    containerEl.createEl('p', {
      text: 'Highlight lines matching regex patterns. First matching rule wins.',
      cls: 'setting-item-description',
    });

    new obsidian.Setting(containerEl)
      .setName('Add new rule')
      .addButton(btn =>
        btn.setButtonText('+ Add Rule').setCta().onClick(async () => {
          this.plugin.settings.rules.push({
            id: crypto.randomUUID(),
            name: 'New Rule',
            pattern: '',
            flags: '',
            background: '#2563eb',
            textColor: '#ffffff',
            bold: true,
            italic: false,
            css: '',
            enabled: true,
          });
          await this.plugin.saveSettings();
          this.display();
        })
      );

    const exampleToggle = containerEl.createEl('details');
    exampleToggle.style.marginBottom = '12px';
    exampleToggle.createEl('summary', { text: 'Example CSS properties' }).style.cssText =
      'font-size:0.85em; cursor:pointer; color:var(--text-muted);';
    exampleToggle.createEl('pre', { text: EXAMPLE_CSS }).style.cssText =
      'font-size:0.8em; padding:8px; background:var(--background-secondary); border-radius:4px; white-space:pre-wrap; user-select:all;';

    containerEl.createEl('hr');

    const rulesContainer = containerEl.createDiv();
    for (let i = 0; i < this.plugin.settings.rules.length; i++) {
      this.renderRule(rulesContainer, this.plugin.settings.rules[i], i);
    }
  }

  renderRule(containerEl, rule, index) {
    const rules = this.plugin.settings.rules;
    const isFirst = index === 0;
    const isLast = index === rules.length - 1;

    const wrapper = containerEl.createDiv();
    wrapper.style.cssText = 'border:1px solid var(--background-modifier-border); border-radius:8px; padding:12px; margin-bottom:16px;';

    // Preview bar
    const preview = wrapper.createDiv();
    const updatePreview = () => {
      const css = rule.css || cssFromControls(rule);
      preview.setAttribute('style', css);
      preview.style.marginBottom = '12px';
      preview.style.fontSize = '0.95em';
      preview.textContent = rule.name || 'Preview';
    };
    updatePreview();

    let cssTextarea = null;
    // Update only the property a control owns, preserving the rest of the rule's
    // CSS (radius, padding, anything hand-edited). value === null removes it.
    const updateCss = (prop, value) => {
      rule.css = setDeclaration(rule.css || cssFromControls(rule), prop, value);
      if (cssTextarea) cssTextarea.value = rule.css;
      updatePreview();
    };

    // Grouped "cards" with multiple rows each — one Obsidian Setting per row
    // becomes its own card on mobile, so we build our own groups instead. Each
    // row is label-left / controls-right; rows in a group share one card.
    const makeGroup = () => wrapper.createDiv({ cls: 'hotline-group' });
    const makeRow = (group, label, wide) => {
      const row = group.createDiv({ cls: 'hotline-row' });
      row.createDiv({ cls: 'hotline-row-label', text: label });
      return row.createDiv({ cls: 'hotline-row-control' + (wide ? ' wide' : '') });
    };
    const muted = (parent, text, ml) => {
      const s = parent.createEl('span', { text });
      s.style.cssText = `font-size:0.85em; color:var(--text-muted);${ml ? ' margin-left:6px;' : ''}`;
    };

    // ── Group: Name + Enabled/move ──
    const nameGroup = makeGroup();
    new obsidian.TextComponent(makeRow(nameGroup, 'Name', true))
      .setValue(rule.name).setPlaceholder('Rule name')
      .onChange(async (val) => {
        rule.name = val;
        updatePreview();
        await this.plugin.saveSettings();
      });

    const enabledCtl = makeRow(nameGroup, 'Enabled');
    new obsidian.ToggleComponent(enabledCtl)
      .setValue(rule.enabled)
      .onChange(async (val) => {
        rule.enabled = val;
        await this.plugin.saveSettings();
        this.plugin.refreshEditors();
      });
    const upBtn = new obsidian.ButtonComponent(enabledCtl).setIcon('arrow-up').setTooltip('Move up');
    if (isFirst) upBtn.buttonEl.style.opacity = '0.3';
    else upBtn.onClick(async () => {
      [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
      await this.plugin.saveSettings();
      this.plugin.refreshEditors();
      this.display();
    });
    const downBtn = new obsidian.ButtonComponent(enabledCtl).setIcon('arrow-down').setTooltip('Move down');
    if (isLast) downBtn.buttonEl.style.opacity = '0.3';
    else downBtn.onClick(async () => {
      [rules[index], rules[index + 1]] = [rules[index + 1], rules[index]];
      await this.plugin.saveSettings();
      this.plugin.refreshEditors();
      this.display();
    });

    // ── Group: Pattern + Case-sensitive ──
    const patternGroup = makeGroup();
    const patternInput = new obsidian.TextComponent(makeRow(patternGroup, 'Pattern', true))
      .setValue(rule.pattern).setPlaceholder('e.g.  \\bTODO\\s+next\\b');
    patternInput.inputEl.style.fontFamily = 'var(--font-monospace)';
    patternInput.onChange(async (val) => {
      try {
        new RegExp(val, rule.flags || '');
        patternInput.inputEl.style.borderColor = '';
      } catch {
        patternInput.inputEl.style.borderColor = 'red';
        return;
      }
      rule.pattern = val;
      await this.plugin.saveSettings();
      this.plugin.refreshEditors();
    });

    new obsidian.ToggleComponent(makeRow(patternGroup, 'Case-sensitive'))
      .setValue(!(rule.flags || '').includes('i'))
      .onChange(async (val) => {
        rule.flags = val
          ? (rule.flags || '').replace(/i/g, '')
          : (rule.flags || '').replace(/i/g, '') + 'i';
        await this.plugin.saveSettings();
        this.plugin.refreshEditors();
      });

    // ── Group: Display (Color + Style) ──
    const displayGroup = makeGroup();
    displayGroup.createDiv({ cls: 'hotline-group-header', text: 'Display' });

    const colorCtl = makeRow(displayGroup, 'Color');
    muted(colorCtl, 'Background');
    colorSwatch(colorCtl, rule.background || '#2563eb', async (val) => {
      rule.background = val;
      updateCss('background', val);
      await this.plugin.saveSettings();
      this.plugin.refreshEditors();
    });
    muted(colorCtl, 'Text', true);
    colorSwatch(colorCtl, rule.textColor || '#ffffff', async (val) => {
      rule.textColor = val;
      updateCss('color', val);
      await this.plugin.saveSettings();
      this.plugin.refreshEditors();
    });

    const styleCtl = makeRow(displayGroup, 'Style');
    muted(styleCtl, 'Bold');
    new obsidian.ToggleComponent(styleCtl)
      .setValue(rule.bold)
      .onChange(async (val) => {
        rule.bold = val;
        updateCss('font-weight', val ? 'bold' : null);
        await this.plugin.saveSettings();
        this.plugin.refreshEditors();
      });
    muted(styleCtl, 'Italic', true);
    new obsidian.ToggleComponent(styleCtl)
      .setValue(rule.italic)
      .onChange(async (val) => {
        rule.italic = val;
        updateCss('font-style', val ? 'italic' : null);
        await this.plugin.saveSettings();
        this.plugin.refreshEditors();
      });

    // ── CSS (collapsible) ──
    const cssDetails = wrapper.createEl('details');
    cssDetails.style.marginTop = '4px';
    cssDetails.createEl('summary', { text: 'CSS' }).style.cssText =
      'font-size:0.85em; cursor:pointer; color:var(--text-muted);';
    cssDetails.createEl('p', {
      text: 'Edit directly for full control. GUI changes will update this field.',
    }).style.cssText = 'font-size:0.8em; color:var(--text-muted); margin:4px 0;';

    cssTextarea = cssDetails.createEl('textarea');
    cssTextarea.style.cssText = 'font-family:var(--font-monospace); width:100%; min-height:60px; font-size:0.85em; box-sizing:border-box;';
    cssTextarea.value = rule.css || cssFromControls(rule);
    cssTextarea.addEventListener('input', async () => {
      rule.css = cssTextarea.value;
      updatePreview();
      await this.plugin.saveSettings();
      this.plugin.refreshEditors();
    });

    if (!rule.css) rule.css = cssFromControls(rule);

    // ── Delete ──
    new obsidian.Setting(wrapper)
      .addButton(btn =>
        btn.setButtonText('Delete Rule').setWarning().onClick(async () => {
          this.plugin.settings.rules = this.plugin.settings.rules.filter(r => r.id !== rule.id);
          await this.plugin.saveSettings();
          this.plugin.refreshEditors();
          this.display();
        })
      );
  }
}

module.exports = HotlinesPlugin;