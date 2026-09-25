import type { MurderMysteryDatabase } from '../../infra/sqlite/database.js'
import type { ScriptDefinition } from './types.js'

type Row=Record<string,unknown>
const now=()=>new Date().toISOString()

export class ScriptRepository {
  constructor(private readonly database:MurderMysteryDatabase) {}

  list():ScriptDefinition[] {
    const rows=this.database.db.prepare("select definition_json from script_versions where status='published' order by created_at desc")
      .all() as Row[]
    const seen=new Set<string>()
    return rows.flatMap(row=>{
      const script=JSON.parse(String(row.definition_json)) as ScriptDefinition
      if(seen.has(script.id)) return []
      seen.add(script.id)
      return [script]
    })
  }

  getById(id:string):ScriptDefinition|undefined {
    const row=this.database.db.prepare("select definition_json from script_versions where script_id=? and status='published' order by created_at desc limit 1")
      .get(id) as Row|undefined
    return row?JSON.parse(String(row.definition_json)) as ScriptDefinition:undefined
  }

  getByVersionId(versionId:string): ScriptDefinition | undefined {
    const row=this.database.db.prepare("select definition_json from script_versions where id=? and status='published'")
      .get(versionId) as Row|undefined
    return row?JSON.parse(String(row.definition_json)) as ScriptDefinition:undefined
  }
  versionId(script:ScriptDefinition): string { return `${script.id}@${script.version}` }

  publish(script:ScriptDefinition,contentHash:string):ScriptDefinition {
    const id=this.versionId(script)
    const existing=this.database.db.prepare('select content_hash,definition_json from script_versions where id=?').get(id) as Row|undefined
    if(existing) {
      if(String(existing.content_hash)!==contentHash) throw new Error('SCRIPT_VERSION_ALREADY_EXISTS')
      return JSON.parse(String(existing.definition_json)) as ScriptDefinition
    }
    this.database.db.prepare(`
      insert into script_versions (id,script_id,version,content_hash,status,definition_json,created_at)
      values (?,?,?,?, 'published', ?,?)
    `).run(id,script.id,script.version,contentHash,JSON.stringify(script),now())
    return script
  }
}
