/* Safe rich-text renderer for knowledge base articles. Input is a small Markdown subset; output is built with DOM
   methods (never innerHTML), so no HTML typed into an article can run. Supported:
   # / ## / ### headings, **bold**, *italic*, `code`, ```code blocks```, - bullets, 1. numbered lists, > quotes,
   --- rules, [text](https://link), and ![alt](image) where image must be an uploaded article image. */
(function () {
  const SAFE_LINK = /^(https?:\/\/|mailto:|\/(?!\/))/i;
  const SAFE_IMG = /^\/api\/public\/kb-images\/[a-f0-9]{32}\.(png|jpe?g|gif|webp)$/;
  const INLINE_SRC = /`([^`]+)`|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*/;

  const node = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };

  function inline(parent, text) {
    let last = 0, m;
    const re = new RegExp(INLINE_SRC.source, "g");   // fresh regex per call: inline() recurses, so shared lastIndex would loop forever
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1] !== undefined) parent.append(node("code", m[1]));
      else if (m[3] !== undefined) {
        if (SAFE_IMG.test(m[3])) { const i = node("img"); i.src = m[3]; i.alt = m[2]; i.loading = "lazy"; parent.append(i); }
        else parent.append(m[2] || "");
      } else if (m[5] !== undefined) {
        if (SAFE_LINK.test(m[5])) { const a = node("a"); a.href = m[5]; a.target = "_blank"; a.rel = "noopener noreferrer"; inline(a, m[4]); parent.append(a); }
        else parent.append(m[4]);
      } else if (m[6] !== undefined) { const b = node("strong"); inline(b, m[6]); parent.append(b); }
      else if (m[7] !== undefined) { const i = node("em"); inline(i, m[7]); parent.append(i); }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function lines(parent, arr) { arr.forEach((l, i) => { if (i) parent.append(node("br")); inline(parent, l); }); }

  window.renderRich = function renderRich(source) {
    const root = document.createElement("div"); root.className = "rich";
    const src = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    const isBlock = l => /^(#{1,3} |[-*] |\d+[.)] |> |```|---+\s*$)/.test(l);
    while (i < src.length) {
      const line = src[i];
      if (!line.trim()) { i++; continue; }
      if (line.startsWith("```")) {                       // code block
        const buf = []; i++;
        while (i < src.length && !src[i].startsWith("```")) buf.push(src[i++]);
        i++; const pre = node("pre"); pre.append(node("code", buf.join("\n"))); root.append(pre); continue;
      }
      const h = line.match(/^(#{1,3}) (.+)$/);
      if (h) { const e = node("h" + (h[1].length + 1)); inline(e, h[2].trim()); root.append(e); i++; continue; }
      if (/^---+\s*$/.test(line)) { root.append(node("hr")); i++; continue; }
      if (/^[-*] /.test(line) || /^\d+[.)] /.test(line)) {  // lists
        const ordered = /^\d+[.)] /.test(line), list = node(ordered ? "ol" : "ul"), re = ordered ? /^\d+[.)] (.*)$/ : /^[-*] (.*)$/;
        let mm;
        while (i < src.length && (mm = src[i].match(re))) { const li = node("li"); inline(li, mm[1]); list.append(li); i++; }
        root.append(list); continue;
      }
      if (line.startsWith("> ")) {                         // quote
        const buf = []; while (i < src.length && src[i].startsWith("> ")) buf.push(src[i++].slice(2));
        const q = node("blockquote"); lines(q, buf); root.append(q); continue;
      }
      const buf = [];                                       // paragraph
      while (i < src.length && src[i].trim() && (buf.length === 0 || !isBlock(src[i]))) buf.push(src[i++]);
      const p = node("p"); lines(p, buf); root.append(p);
    }
    return root;
  };
})();
