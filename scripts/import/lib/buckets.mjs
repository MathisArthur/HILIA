/** Hash FNV-1a : le navigateur doit calculer exactement le même shard. */
export function bucketOf(id, count) {
  let hash = 2166136261;
  for (const ch of String(id)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

export function bucketName(bucket) {
  return String(bucket).padStart(3, '0');
}
