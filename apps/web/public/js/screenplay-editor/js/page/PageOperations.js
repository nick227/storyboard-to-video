export class PageOperations {
    insertLine (targetPage, lineElement, refElement = null) {
        if (!targetPage || !lineElement) return;
        if (refElement && refElement.nextSibling) {
            targetPage.insertBefore(lineElement, refElement.nextSibling);
        } else if (refElement) {
            targetPage.appendChild(lineElement);
        } else {
            targetPage.appendChild(lineElement);
        }
    }

    removeLine (lineElement) {
        if (lineElement && lineElement.parentNode) {
            lineElement.parentNode.removeChild(lineElement);
        }
    }
}
