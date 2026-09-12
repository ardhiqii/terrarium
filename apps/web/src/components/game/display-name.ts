/** Shared companion name display helper used by several game surfaces. */

export function displayCompanionName(companionId: string): string {
  const name = companionId.replace(/[-_]+/g, ' ').trim()
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Unnamed companion'
}
