export class PageBreakManager {
    constructor (pageManager) {
        this.pageManager = pageManager;
    }

    checkAndRecalculate () {
        // Page break calculation logic across script pages
        if (!this.pageManager || !this.pageManager.container) return;
        const pages = Array.from(this.pageManager.container.querySelectorAll('.script-page'));
        const maxPerPg = this.pageManager.maxLinesPerPage || 54;

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const lines = Array.from(page.querySelectorAll('.script-line'));

            if (lines.length > maxPerPg) {
                const overflowLines = lines.slice(maxPerPg);
                let nextPage = pages[i + 1];
                if (!nextPage) {
                    nextPage = this.pageManager.pageFactory.createPage(i + 2);
                    this.pageManager.container.appendChild(nextPage);
                    pages.push(nextPage);
                }

                overflowLines.forEach((l, idx) => {
                    const firstLineOfNext = nextPage.children[idx];
                    if (firstLineOfNext) {
                        nextPage.insertBefore(l, firstLineOfNext);
                    } else {
                        nextPage.appendChild(l);
                    }
                });
            }
        }
    }
}
