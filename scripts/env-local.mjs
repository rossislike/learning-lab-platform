import { readFile } from "node:fs/promises"

export function parseEnvValue(contents, name) {
  const line = contents
    .split(/\r?\n/)
    .find((entry) => entry.trimStart().startsWith(`${name}=`))
  if (!line) return undefined
  const value = line.slice(line.indexOf("=") + 1).trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export async function readEnvLocalValue(name, url) {
  try {
    return parseEnvValue(await readFile(url, "utf8"), name)
  } catch {
    return undefined
  }
}
