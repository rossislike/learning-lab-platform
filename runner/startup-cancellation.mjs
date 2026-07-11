export async function cleanupCancelledStartup({ cleanup, markCleaned }) {
  const result = await cleanup()
  await markCleaned(result)
  return false
}
