import { VALID_FORMATS, DEFAULT_FORMAT, isValidFormat, getNextFormat } from './constants/formats.js';

export class LineFormatter {
    constructor () {
        this.VALID_FORMATS = VALID_FORMATS;
        this.DEFAULT_FORMAT = DEFAULT_FORMAT;
    }

    getNextFormatInFlow (currentFormat, direction = 1) {
        return getNextFormat(currentFormat, direction);
    }

    applyFormat (element, format) {
        if (!element || !(element instanceof HTMLElement)) return;
        const validFormat = isValidFormat(format) ? format : DEFAULT_FORMAT;
        element.setAttribute('data-format', validFormat);
    }
}
