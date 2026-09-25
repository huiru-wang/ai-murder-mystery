import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DiscussionMode, GameToolName } from '@ai-murder-mystery/shared'
import { ScriptRepository } from './repository.js'
import type { ClueDefinition, RoleDefinition, RoundDefinition, ScriptDefinition } from './types.js'

type Value=Record<string,unknown>
const tools=new Set<GameToolName>([
  'send_message','ask_player','reply_question','decline_question','yield_turn','finish_round','pass',
  'search_clue','reveal_clue','keep_clue_private','finish_search','submit_vote',
])
const isRecord=(value:unknown):value is Value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)
const text=(value:unknown,name:string)=>{
  if(typeof value!=='string'||!value.trim()) throw new Error(`SCRIPT_INVALID_${name}`)
  return value
}
const list=(value:unknown,name:string)=>{
  if(!Array.isArray(value)) throw new Error(`SCRIPT_INVALID_${name}`)
  return value
}
const stringList=(value:unknown,name:string)=>list(value,name).map(item=>text(item,name))
const record=(value:unknown,name:string)=>{
  if(!isRecord(value)) throw new Error(`SCRIPT_INVALID_${name}`)
  return value
}

export class ScriptPackageImporter {
  constructor(private readonly scripts:ScriptRepository) {}

  importZip(bytes:Buffer):ScriptDefinition {
    if(bytes.length===0||bytes.length>10*1024*1024) throw new Error('SCRIPT_PACKAGE_SIZE_INVALID')
    const directory=mkdtempSync(join(tmpdir(),'murder-mystery-script-'))
    const archive=join(directory,'package.zip')
    try {
      writeFileSync(archive,bytes,{flag:'wx'})
      const entries=String(execFileSync('unzip',['-Z1',archive],{encoding:'utf8',maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']}))
        .split('\n').filter(Boolean)
      if(entries.length<3||entries.length>64) throw new Error('SCRIPT_PACKAGE_FILE_COUNT_INVALID')
      if(entries.some(entry=>entry.startsWith('/')||entry.includes('..')||entry.includes('\\'))) throw new Error('SCRIPT_PACKAGE_PATH_INVALID')
      const roots=[...new Set(entries.map(entry=>entry.split('/')[0]).filter(Boolean))]
      if(roots.length!==1) throw new Error('SCRIPT_PACKAGE_ROOT_INVALID')
      const root=roots[0]!
      const required=[`${root}/manifest.json`,`${root}/game.json`]
      if(required.some(path=>!entries.includes(path))) throw new Error('SCRIPT_PACKAGE_FILES_MISSING')
      if(entries.some(entry=>!entry.endsWith('/')&&!entry.startsWith(`${root}/assets/`)&&!required.includes(entry)&&entry!==`${root}/README.md`)) {
        throw new Error('SCRIPT_PACKAGE_FILE_NOT_ALLOWED')
      }
      const manifest=this.readJson(archive,required[0]!)
      const game=this.readJson(archive,required[1]!)
      const script=this.parse(manifest,game,root)
      const hash=createHash('sha256').update(JSON.stringify(manifest)).update(JSON.stringify(game)).digest('hex')
      return this.scripts.publish(script,hash)
    } catch(error) {
      if(error instanceof Error&&error.message.startsWith('SCRIPT_')) throw error
      throw new Error('SCRIPT_PACKAGE_INVALID')
    } finally {
      rmSync(directory,{recursive:true,force:true})
    }
  }

  private readJson(archive:string,path:string):Value {
    try {
      const output=execFileSync('unzip',['-p',archive,path],{encoding:'buffer',maxBuffer:2*1024*1024,stdio:['ignore','pipe','ignore']})
      return record(JSON.parse(output.toString('utf8')),'JSON')
    }
    catch(error) { if(error instanceof Error&&error.message.startsWith('SCRIPT_')) throw error; throw new Error('SCRIPT_PACKAGE_JSON_INVALID') }
  }

  private parse(manifest:Value,game:Value,root:string):ScriptDefinition {
    const id=text(manifest.id,'MANIFEST_ID')
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)||root!==id) throw new Error('SCRIPT_INVALID_ID')
    if(text(manifest.schemaVersion,'SCHEMA_VERSION')!=='1.0') throw new Error('SCRIPT_SCHEMA_UNSUPPORTED')
    const version=text(manifest.version,'MANIFEST_VERSION')
    if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('SCRIPT_INVALID_VERSION')
    const roles=list(game.roles,'ROLES').map((item,index)=>this.role(record(item,`ROLE_${index}`)))
    const locations=list(game.locations,'LOCATIONS').map((item,index)=>{
      const value=record(item,`LOCATION_${index}`)
      return {id:text(value.id,'LOCATION_ID'),name:text(value.name,'LOCATION_NAME'),description:text(value.description,'LOCATION_DESCRIPTION')}
    })
    const rounds=list(game.phases,'PHASES').map((item,index)=>this.round(record(item,`PHASE_${index}`)))
    const clues=list(game.clues,'CLUES').map((item,index)=>this.clue(record(item,`CLUE_${index}`)))
    const truth=record(game.outcome,'OUTCOME')
    const definition:ScriptDefinition={
      id,version,title:text(manifest.title,'MANIFEST_TITLE'),description:text(manifest.description,'MANIFEST_DESCRIPTION'),
      publicContext:text(game.publicContext,'PUBLIC_CONTEXT'),roles,locations,rounds,clues,
      truth:{murdererRoleId:text(truth.murdererRoleId,'MURDERER_ROLE_ID'),content:text(truth.truth,'TRUTH')},
    }
    this.validate(definition,manifest)
    return definition
  }

  private role(value:Value):RoleDefinition {
    const privateInfo=record(value.private,'ROLE_PRIVATE')
    const policy=record(value.deceptionPolicy,'DECEPTION_POLICY')
    if(typeof policy.mayHideOwnFacts!=='boolean'||typeof policy.mayLieAboutOwnActions!=='boolean'||typeof policy.forbiddenWorldFabrication!=='boolean') throw new Error('SCRIPT_INVALID_DECEPTION_POLICY')
    const age=Number(value.age)
    if(!Number.isInteger(age)||age<1||age>150) throw new Error('SCRIPT_INVALID_ROLE_AGE')
    return {
      id:text(value.id,'ROLE_ID'),name:text(value.name,'ROLE_NAME'),age,gender:text(value.gender,'ROLE_GENDER'),occupation:text(value.occupation,'ROLE_OCCUPATION'),publicProfile:text(value.publicProfile,'ROLE_PUBLIC_PROFILE'),
      privateStory:text(privateInfo.story,'ROLE_PRIVATE_STORY'),knownFacts:stringList(privateInfo.facts,'ROLE_FACTS'),secrets:stringList(privateInfo.secrets,'ROLE_SECRETS'),goals:stringList(privateInfo.goals,'ROLE_GOALS'),relationships:stringList(privateInfo.relationships,'ROLE_RELATIONSHIPS'),
      deceptionPolicy:{mayHideOwnFacts:policy.mayHideOwnFacts,mayLieAboutOwnActions:policy.mayLieAboutOwnActions,forbiddenWorldFabrication:policy.forbiddenWorldFabrication},
    }
  }

  private round(value:Value):RoundDefinition {
    const kind=text(value.kind,'PHASE_KIND')
    const allowed=stringList(value.allowedActions,'PHASE_ACTIONS') as GameToolName[]
    if(allowed.some(item=>!tools.has(item))) throw new Error('SCRIPT_INVALID_ACTION')
    const base={id:text(value.id,'PHASE_ID'),title:text(value.title,'PHASE_TITLE')}
    if(kind==='discussion') {
      const discussion=record(value.discussion,'DISCUSSION')
      const mode=text(discussion.mode,'DISCUSSION_MODE') as DiscussionMode
      if(!['ordered','free','ordered_opportunity_then_free'].includes(mode)) throw new Error('SCRIPT_INVALID_DISCUSSION_MODE')
      const requiredAction=discussion.requiredAction===undefined?undefined:text(discussion.requiredAction,'REQUIRED_ACTION')
      if(requiredAction!==undefined&&requiredAction!=='introduce') throw new Error('SCRIPT_INVALID_REQUIRED_ACTION')
      const turnOrder=discussion.turnOrder===undefined?undefined:text(discussion.turnOrder,'TURN_ORDER')
      if(turnOrder!==undefined&&turnOrder!=='random'&&turnOrder!=='seat') throw new Error('SCRIPT_INVALID_TURN_ORDER')
      return {
        ...base,type:'discussion',mode,requiredAction,turnOrder,
        allowedTools:requiredAction==='introduce'?['send_message']:allowed,
      }
    }
    if(kind==='investigation') {
      const config=record(value.investigation,'INVESTIGATION')
      const actionsPerPlayer=Number(config.actionsPerPlayer)
      if(!Number.isInteger(actionsPerPlayer)||actionsPerPlayer<1||actionsPerPlayer>3||config.searchTargets!=='locations') throw new Error('SCRIPT_INVALID_INVESTIGATION')
      return {...base,type:'search',actionsPerPlayer,allowedTools:allowed}
    }
    if(kind==='vote') return {...base,type:'vote',allowedTools:['submit_vote']}
    if(kind==='reveal') return {...base,type:'reveal',allowedTools:[]}
    throw new Error('SCRIPT_INVALID_PHASE_KIND')
  }

  private clue(value:Value):ClueDefinition {
    const source=record(value.source,'CLUE_SOURCE')
    const distribution=record(value.distribution,'CLUE_DISTRIBUTION')
    if(source.kind!=='location'||distribution.kind!=='per_player_random') throw new Error('SCRIPT_INVALID_CLUE_DISTRIBUTION')
    const revealPolicy=text(distribution.revealPolicy,'CLUE_REVEAL_POLICY')
    if(!['forced_public','owner_decides','private'].includes(revealPolicy)) throw new Error('SCRIPT_INVALID_CLUE_REVEAL_POLICY')
    return {id:text(value.id,'CLUE_ID'),title:text(value.title,'CLUE_TITLE'),roundId:text(value.phaseId,'CLUE_PHASE_ID'),locationId:text(source.id,'CLUE_LOCATION_ID'),content:text(value.content,'CLUE_CONTENT'),revealPolicy:revealPolicy as ClueDefinition['revealPolicy']}
  }

  private validate(script:ScriptDefinition,manifest:Value) {
    const unique=(items:Array<{id:string}>,name:string)=>{ if(new Set(items.map(item=>item.id)).size!==items.length) throw new Error(`SCRIPT_DUPLICATE_${name}`) }
    unique(script.roles,'ROLES'); unique(script.locations,'LOCATIONS'); unique(script.rounds,'PHASES'); unique(script.clues,'CLUES')
    if(!Number.isInteger(manifest.minPlayers)||!Number.isInteger(manifest.maxPlayers)||manifest.minPlayers!==script.roles.length||manifest.maxPlayers!==script.roles.length) throw new Error('SCRIPT_PLAYER_COUNT_INVALID')
    const first=script.rounds[0]
    const penultimate=script.rounds.at(-2)
    const last=script.rounds.at(-1)
    if(!first||first.type!=='discussion'||first.mode!=='ordered'||first.requiredAction!=='introduce'||first.turnOrder!=='random') throw new Error('SCRIPT_OPENING_INVALID')
    if(!penultimate||penultimate.type!=='vote'||!last||last.type!=='reveal') throw new Error('SCRIPT_ENDING_INVALID')
    if(script.rounds.length<5||script.rounds.length>10) throw new Error('SCRIPT_PHASE_COUNT_INVALID')
    if(!script.rounds.some(round=>round.type==='search')||!script.rounds.slice(1,-2).some(round=>round.type==='discussion')) throw new Error('SCRIPT_FLOW_INVALID')
    const roleIds=new Set(script.roles.map(role=>role.id))
    const phaseIds=new Set(script.rounds.map(round=>round.id))
    const locationIds=new Set(script.locations.map(location=>location.id))
    if(!roleIds.has(script.truth.murdererRoleId)) throw new Error('SCRIPT_MURDERER_NOT_FOUND')
    for(const clue of script.clues) {
      const phase=script.rounds.find(round=>round.id===clue.roundId)
      if(!phase||phase.type!=='search') throw new Error('SCRIPT_CLUE_PHASE_INVALID')
      if(!locationIds.has(clue.locationId)) throw new Error('SCRIPT_CLUE_LOCATION_INVALID')
    }
  }
}
