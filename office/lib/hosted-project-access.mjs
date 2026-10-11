// Bind every hosted project operation to the verified Vercel OAuth subject.
// A future route must use this facade; caller-supplied owner IDs are ignored.
export function createHostedProjectAccess({ auth, store }) {
  if (typeof auth?.authorize !== 'function' || !store) throw new Error('Hosted project access is not configured');
  function owner(cookie) {
    const access = auth.authorize(cookie);
    if (access.status !== 200 || typeof access.sub !== 'string' || !access.sub) throw new Error('Office access denied');
    return access.sub;
  }
  return {
    create(cookie, { id, requestId, snapshot }) { return store.create({ ownerSub: owner(cookie), id, requestId, snapshot }); },
    read(cookie, id) { return store.read({ ownerSub: owner(cookie), id }); },
    update(cookie, { id, expectedVersion, snapshot }) { return store.update({ ownerSub: owner(cookie), id, expectedVersion, snapshot }); },
  };
}
