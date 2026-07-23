export class PageFactory {
    createPage (pageNumber = 1) {
        const page = document.createElement('div');
        page.className = 'script-page';
        page.dataset.pageNumber = String(pageNumber);
        return page;
    }

    createLine (format = 'action', content = '', id = null) {
        const line = document.createElement('div');
        line.className = 'script-line';
        line.contentEditable = 'true';
        line.setAttribute('data-format', format);
        line.dataset.lineId = id || `line_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        line.textContent = content;
        return line;
    }
}
