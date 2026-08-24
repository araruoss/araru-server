export function preserveManualValue(field, current, proposed, manualFields = []) {
  if (manualFields.includes(field)) return current;
  return proposed || current;
}
