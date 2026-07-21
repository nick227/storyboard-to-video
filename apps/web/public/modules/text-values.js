// Scene text can arrive from old browser storage as a wrapped value. Never let the DOM's implicit
// object coercion turn that data into the literal "[object Object]" in an editable field.
export function textValue(value, preferredKeys = []) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';

  for (const key of [...preferredKeys, 'text', 'value', 'content', 'output']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const nested = textValue(value[key], preferredKeys);
    if (nested) return nested;
  }
  return '';
}
