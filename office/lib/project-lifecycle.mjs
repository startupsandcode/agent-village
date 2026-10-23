// Archiving hides saved work without removing artifacts, usage or budget claims.
export const runningProjectStatuses = new Set(['clarifying', 'planning', 'building', 'revising', 'reviewing']);
export function isArchived(project) { return project?.archivedAt != null; }
export function requireActiveProject(project) {
  if (isArchived(project)) throw new Error('Project is archived; restore it first');
}
export function archiveBlocked(project) {
  return runningProjectStatuses.has(project.status) || Object.values(project.publishing ?? {}).some(receipt =>
    ['submitting', 'needs_inspection'].includes(receipt?.status));
}
