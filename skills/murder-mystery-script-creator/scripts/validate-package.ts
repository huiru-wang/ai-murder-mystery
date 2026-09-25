#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MurderMysteryDatabase } from '../../../apps/murder-mystery-api/src/infra/sqlite/database.ts'
import { ScriptRepository } from '../../../apps/murder-mystery-api/src/domain/script/repository.ts'
import { ScriptPackageImporter } from '../../../apps/murder-mystery-api/src/domain/script/importer.ts'

const [packagePath] = process.argv.slice(2)

if (!packagePath || process.argv.length !== 3) {
  console.error('Usage: pnpm --filter @ai-murder-mystery/api exec tsx ../../skills/murder-mystery-script-creator/scripts/validate-package.ts <package.zip>')
  process.exitCode = 64
} else {
  const database = new MurderMysteryDatabase(':memory:')
  try {
    const script = new ScriptPackageImporter(new ScriptRepository(database)).importZip(readFileSync(resolve(packagePath)))
    console.log(JSON.stringify({
      valid: true,
      id: script.id,
      version: script.version,
      title: script.title,
      playerCount: script.roles.length,
      phaseCount: script.rounds.length,
      clueCount: script.clues.length,
    }, null, 2))
  } catch (error) {
    const code = error instanceof Error ? error.message : 'SCRIPT_PACKAGE_INVALID'
    console.error(JSON.stringify({ valid: false, error: code }, null, 2))
    process.exitCode = 1
  } finally {
    database.close()
  }
}
