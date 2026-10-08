/** Small, safe Markdown renderer for meeting summaries.
 *  Supports headings, paragraphs, bulleted and numbered lists (nested by
 *  indentation), **bold**, *italic*, and [links](https://...) (https only). All text is
 *  HTML-escaped first, so a summary can never inject markup into the page.
 *  Shared by the website widget and the staff review app's preview.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function emphasis(html) {
  return html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>");
}

const LINK = /(\[[^\]]+\]\(https:\/\/[^\s)]+\))/;

function inline(text) {
  // Links are cut out first so bold/italic markers can never land inside an href.
  return String(text)
    .split(LINK)
    .map((part, i) => {
      if (i % 2 === 0) return emphasis(escapeHtml(part));
      const [, label, url] = /^\[([^\]]+)\]\((.+)\)$/.exec(part);
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${emphasis(escapeHtml(label))}</a>`;
    })
    .join("");
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const lists = []; // open lists: { type: "ul" | "ol", indent }
  let para = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const closeLists = (aboveIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > aboveIndent) {
      out.push(`</li></${lists.pop().type}>`);
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "    ");
    // Blank lines end a paragraph but keep lists open, so "1." ... "2." stays one list.
    if (!line.trim()) {
      flushPara();
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushPara();
      closeLists();
      const level = Math.min(6, Math.max(3, heading[1].length + 1));
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const item = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const indent = item[1].length;
      const type = item[3] ? "ol" : "ul";
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (top && top.indent === indent && top.type === type) {
        out.push("</li><li>");
      } else {
        if (top && top.indent === indent) out.push(`</li></${lists.pop().type}>`);
        const start = type === "ol" && item[3] !== "1" ? ` start="${Number(item[3])}"` : "";
        lists.push({ type, indent });
        out.push(`<${type}${start}><li>`);
      }
      out.push(inline(item[4]));
      continue;
    }

    // An indented line inside a list continues the current item.
    if (lists.length && /^\s/.test(line)) {
      out.push(" " + inline(line.trim()));
      continue;
    }

    closeLists();
    para.push(line.trim());
  }

  flushPara();
  closeLists();
  return out.join("");
}
