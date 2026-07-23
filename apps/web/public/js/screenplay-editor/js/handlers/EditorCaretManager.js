export class EditorCaretManager {
    static getCaretPosition (element) {
        if (!element) return 0;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return 0;
        const range = selection.getRangeAt(0);
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(element);
        preCaretRange.setEnd(range.endContainer, range.endOffset);
        return preCaretRange.toString().length;
    }

    static setCaretPosition (element, offset) {
        if (!element) return;
        element.focus();
        const selection = window.getSelection();
        if (!selection) return;

        const range = document.createRange();
        let currentLen = 0;
        let foundNode = null;
        let nodeOffset = 0;

        function traverse (node) {
            if (foundNode) return;
            if (node.nodeType === Node.TEXT_NODE) {
                const len = node.nodeValue.length;
                if (currentLen + len >= offset) {
                    foundNode = node;
                    nodeOffset = offset - currentLen;
                    return;
                }
                currentLen += len;
            } else {
                for (let child of node.childNodes) {
                    traverse(child);
                }
            }
        }

        traverse(element);

        if (foundNode) {
            range.setStart(foundNode, nodeOffset);
        } else {
            range.selectNodeContents(element);
        }

        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }
}
