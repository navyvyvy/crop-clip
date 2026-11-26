export function getShortcutKey(event: KeyboardEvent): string {
  if (/^[a-z0-9]$/i.test(event.key) || !/^(Key[A-Z]|Digit[0-9])$/.test(event.code)) {
    return event.key.toLowerCase();
  }
  return event.code.slice(-1).toLowerCase();
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && (target.closest("input, textarea, select") !== null
    || (target instanceof HTMLElement && target.isContentEditable));
}
