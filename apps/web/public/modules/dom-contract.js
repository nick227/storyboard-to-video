export function assertElements(feature, elements, requiredNames = Object.keys(elements)) {
  const missing = requiredNames.filter((name) => {
    const value = elements[name];
    return value == null || (Array.isArray(value) && value.length === 0);
  });
  if (missing.length) {
    throw new Error(`${feature} is missing required DOM bindings: ${missing.join(', ')}`);
  }
  return elements;
}
