const FIELDS = ['audience', 'expertise', 'rules'];
const EMPTY = { audience: '', expertise: '', rules: '' };

export function normalizeDomainProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== FIELDS.length ||
      FIELDS.some(field => typeof value[field] !== 'string' || value[field].length > 500 ||
        /[\x00-\x08\x0b-\x1f\x7f]/.test(value[field]))) throw new Error('Domain answers must be text under 500 characters each');
  return Object.fromEntries(FIELDS.map(field => [field, value[field].trim()]));
}

export function createHostedDomain({ query, auth, containsSecret = () => false }) {
  if (typeof query !== 'function' || typeof auth?.authorize !== 'function') throw new Error('Domain storage requires database and auth');
  function owner(cookie) {
    const access = auth.authorize(cookie);
    if (access.status !== 200 || typeof access.sub !== 'string' || !access.sub) throw new Error('Office access denied');
    return access.sub;
  }
  function clean(value) {
    const profile = normalizeDomainProfile(value);
    if (Object.values(profile).some(containsSecret)) throw new Error('Do not put an API key in domain answers');
    return profile;
  }
  return {
    async read(cookie) {
      const result = await query('SELECT profile FROM village_domain_profiles WHERE owner_sub = $1', [owner(cookie)]);
      return result.rows[0] ? clean(result.rows[0].profile) : { ...EMPTY };
    },
    async save(cookie, value) {
      const profile = clean(value);
      await query(`INSERT INTO village_domain_profiles (owner_sub, profile) VALUES ($1, $2::jsonb)
        ON CONFLICT (owner_sub) DO UPDATE SET profile = EXCLUDED.profile, updated_at = now()`,
      [owner(cookie), JSON.stringify(profile)]);
      return profile;
    },
  };
}
