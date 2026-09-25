import { seventhPierV2 } from './seventh-pier.js'
import type { ScriptDefinition } from './types.js'

const scripts = [seventhPierV2]

export class ScriptRepository {
  list(): ScriptDefinition[] { return scripts }
  getById(id:string): ScriptDefinition | undefined { return scripts.find(script=>script.id===id) }
  getByVersionId(versionId:string): ScriptDefinition | undefined {
    return scripts.find(script=>`${script.id}@${script.version}`===versionId)
  }
  versionId(script:ScriptDefinition): string { return `${script.id}@${script.version}` }
}
