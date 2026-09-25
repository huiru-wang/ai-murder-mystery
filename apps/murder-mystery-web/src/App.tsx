import { useEffect, useMemo, useState } from 'react'
import type {
  ClueView,
  PendingQuestionView,
  PublicTimelineEvent,
  ReviewClueView,
  RoomPlayerView,
  RoomView,
  ScriptSummary,
} from '@ai-murder-mystery/shared'
import './App.css'

const API=''
const LEGACY_STORAGE_KEY='murder-mystery-v2-session'
const ACTIVE_ROOM_KEY='murder-mystery-v2-active-room'
const ROOM_INDEX_KEY='murder-mystery-v2-room-index'

type SessionRef={roomId:string;playerId:string}
type SavedRoomRef=SessionRef&{savedAt:string}
type GameTab='chat'|'clues'|'role'|'story'|'progress'
type ClueTab='public'|'private'
type RoleTab='story'|'facts'|'secrets'|'goals'|'relations'
type ReviewTab='truth'|'roles'|'clues'|'timeline'|'votes'

const GAME_TABS:Array<{id:GameTab;label:string;short:string}>=[
  {id:'chat',label:'群聊',short:'聊'},
  {id:'clues',label:'线索',short:'证'},
  {id:'role',label:'我的角色',short:'角'},
  {id:'story',label:'故事',short:'事'},
  {id:'progress',label:'进程',short:'程'},
]

const REVIEW_TABS:Array<{id:ReviewTab;label:string}>=[
  {id:'truth',label:'真相'},
  {id:'roles',label:'所有角色'},
  {id:'clues',label:'全部线索'},
  {id:'timeline',label:'完整时间线'},
  {id:'votes',label:'投票'},
]

async function request<T>(path:string,init?:RequestInit):Promise<T>{
  const response=await fetch(API+path,init)
  const body=await response.json()
  if(!response.ok)throw new Error(body.error??'请求失败')
  return body as T
}

const json=(body:unknown):RequestInit=>({
  method:'POST',
  headers:{'content-type':'application/json'},
  body:JSON.stringify(body),
})

const commandId=()=>crypto.randomUUID()

function readSession(key:string):SessionRef|null{
  try{
    const raw=localStorage.getItem(key)
    if(!raw)return null
    const value=JSON.parse(raw) as Partial<SessionRef>
    return value.roomId&&value.playerId?{roomId:value.roomId,playerId:value.playerId}:null
  }catch{return null}
}

function readRoomIndex():SavedRoomRef[]{
  try{
    const raw=localStorage.getItem(ROOM_INDEX_KEY)
    const parsed=raw?JSON.parse(raw) as Array<Partial<SavedRoomRef>>:[]
    const items=parsed.filter((item):item is SavedRoomRef=>Boolean(item.roomId&&item.playerId&&item.savedAt))
    const legacy=readSession(LEGACY_STORAGE_KEY)
    if(legacy&&!items.some(item=>item.roomId===legacy.roomId&&item.playerId===legacy.playerId)){
      items.unshift({...legacy,savedAt:new Date().toISOString()})
    }
    return items
  }catch{return []}
}

function readActiveRoom():SessionRef|null{
  return readSession(ACTIVE_ROOM_KEY)??readSession(LEGACY_STORAGE_KEY)
}

function writeRoomIndex(items:SavedRoomRef[]){
  localStorage.setItem(ROOM_INDEX_KEY,JSON.stringify(items))
  localStorage.removeItem(LEGACY_STORAGE_KEY)
}

export default function App(){
  const [scripts,setScripts]=useState<ScriptSummary[]>([])
  const [scriptId,setScriptId]=useState('')
  const [session,setSession]=useState<SessionRef|null>(()=>readActiveRoom())
  const [roomRefs,setRoomRefs]=useState<SavedRoomRef[]>(()=>readRoomIndex())
  const [savedRooms,setSavedRooms]=useState<RoomView[]>([])
  const [room,setRoom]=useState<RoomView|null>(null)
  const [activeTab,setActiveTab]=useState<GameTab>('chat')
  const [clueTab,setClueTab]=useState<ClueTab>('public')
  const [roleTab,setRoleTab]=useState<RoleTab>('story')
  const [reviewTab,setReviewTab]=useState<ReviewTab>('truth')
  const [reviewRoleId,setReviewRoleId]=useState('')
  const [message,setMessage]=useState('')
  const [targetPlayerId,setTargetPlayerId]=useState('')
  const [mentionOpen,setMentionOpen]=useState(false)
  const [replyQuestionId,setReplyQuestionId]=useState('')
  const [voteTarget,setVoteTarget]=useState('')
  const [playerSheet,setPlayerSheet]=useState<RoomPlayerView|null>(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')

  const selectedScript=useMemo(()=>scripts.find(item=>item.id===scriptId),[scripts,scriptId])
  const otherPlayers=room?.players.filter(player=>player.id!==session?.playerId)??[]
  const actions=useMemo(()=>new Set(room?.availableActions??[]),[room?.availableActions])
  const selectedTarget=otherPlayers.find(player=>player.id===targetPlayerId)??null
  const replyQuestion=room?.pendingQuestionsForMe.find(question=>question.id===replyQuestionId)??null

  function showError(value:unknown){
    setError(value instanceof Error?humanizeError(value.message):'操作失败')
  }

  function forgetRoom(ref:SessionRef){
    setRoomRefs(current=>{
      const next=current.filter(item=>item.roomId!==ref.roomId||item.playerId!==ref.playerId)
      writeRoomIndex(next)
      return next
    })
    const active=readSession(ACTIVE_ROOM_KEY)
    if(active?.roomId===ref.roomId&&active.playerId===ref.playerId)localStorage.removeItem(ACTIVE_ROOM_KEY)
    setSession(current=>current?.roomId===ref.roomId&&current.playerId===ref.playerId?null:current)
    setRoom(current=>current?.id===ref.roomId?null:current)
  }

  useEffect(()=>{
    void request<{items:ScriptSummary[]}>('/api/scripts')
      .then(result=>{
        setScripts(result.items)
        setScriptId(current=>current&&result.items.some(item=>item.id===current)?current:result.items[0]?.id??'')
      })
      .catch(showError)
  },[])

  useEffect(()=>{
    writeRoomIndex(roomRefs)
  },[roomRefs])

  useEffect(()=>{
    if(session)return
    let cancelled=false
    const loadSaved=async()=>{
      const valid:SavedRoomRef[]=[]
      const views:RoomView[]=[]
      for(const ref of roomRefs){
        try{
          const view=await request<RoomView>('/api/rooms/'+ref.roomId+'?playerId='+ref.playerId)
          valid.push(ref)
          views.push(view)
        }catch{
          // Stale local references are removed after a server reset or room deletion.
        }
      }
      if(cancelled)return
      if(valid.length!==roomRefs.length){
        setRoomRefs(valid)
        writeRoomIndex(valid)
      }
      setSavedRooms(views)
    }
    void loadSaved()
    return()=>{cancelled=true}
  },[session,roomRefs])

  useEffect(()=>{
    if(!session)return
    let cancelled=false
    const load=async()=>{
      try{
        const next=await request<RoomView>('/api/rooms/'+session.roomId+'?playerId='+session.playerId)
        if(!cancelled){
          setRoom(next)
          setError('')
          if(next.status==='completed'&&!reviewRoleId&&next.review?.roles[0])setReviewRoleId(next.review.roles[0].roleId)
        }
      }catch(err){
        if(cancelled)return
        const message=err instanceof Error?err.message:''
        if(message==='ROOM_NOT_FOUND'||message==='PLAYER_NOT_FOUND'){
          forgetRoom(session)
          return
        }
        showError(err)
      }
    }
    void load()
    const timer=window.setInterval(()=>void load(),1200)
    return()=>{cancelled=true;window.clearInterval(timer)}
  },[session,reviewRoleId])

  async function act(fn:()=>Promise<RoomView|void>){
    setBusy(true)
    setError('')
    try{
      const next=await fn()
      if(next)setRoom(next)
    }catch(err){showError(err)}
    finally{setBusy(false)}
  }

  function saveSession(ref:SessionRef){
    const savedAt=new Date().toISOString()
    setRoomRefs(current=>{
      const next=[{...ref,savedAt},...current.filter(item=>item.roomId!==ref.roomId||item.playerId!==ref.playerId)]
      writeRoomIndex(next)
      return next
    })
    localStorage.setItem(ACTIVE_ROOM_KEY,JSON.stringify(ref))
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    setSession(ref)
  }

  async function removeRoom(ref:SessionRef){
    await act(async()=>{
      await request<{ok:boolean}>(`/api/rooms/${ref.roomId}?playerId=${encodeURIComponent(ref.playerId)}`,{method:'DELETE'})
      forgetRoom(ref)
    })
  }

  function resumeRoom(ref:SessionRef){
    const savedAt=new Date().toISOString()
    setRoomRefs(current=>{
      const next=[{...ref,savedAt},...current.filter(item=>item.roomId!==ref.roomId||item.playerId!==ref.playerId)]
      writeRoomIndex(next)
      return next
    })
    localStorage.setItem(ACTIVE_ROOM_KEY,JSON.stringify(ref))
    setError('')
    setRoom(null)
    setSession(ref)
  }

  async function createRoom(){
    await act(async()=>{
      const created=await request<RoomView>('/api/rooms',json({scriptId,humanCount:1}))
      if(!created.me)throw new Error('房间没有真人玩家')
      saveSession({roomId:created.id,playerId:created.me.id})
      return created
    })
  }

  async function importScript(file:File){
    await act(async()=>{
      const form=new FormData()
      form.set('package',file)
      const result=await request<{item:ScriptSummary}>('/api/scripts/import',{method:'POST',body:form})
      setScripts(current=>[result.item,...current.filter(item=>item.id!==result.item.id)])
      setScriptId(result.item.id)
    })
  }

  async function post(path:string,body:Record<string,unknown>={}){
    if(!session)throw new Error('没有当前房间')
    return request<RoomView>('/api/rooms/'+session.roomId+path,json({playerId:session.playerId,...body}))
  }

  function leaveLocal(){
    localStorage.removeItem(ACTIVE_ROOM_KEY)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    setSession(null)
    setRoom(null)
    setError('')
    setActiveTab('chat')
  }

  async function searchLocation(locationId:string){
    const privateCount=room?.privateClues.length??0
    await act(async()=>{
      const next=await post('/actions/search',{commandId:commandId(),locationId})
      setClueTab(next.privateClues.length>privateCount?'private':'public')
      setActiveTab('clues')
      return next
    })
  }

  async function sendComposer(){
    const content=message.trim()
    if(!content)return
    if(replyQuestion&&actions.has('REPLY_QUESTION')){
      await act(async()=>{
        const next=await post('/actions/reply',{
          commandId:commandId(),
          questionId:replyQuestion.id,
          content,
        })
        setMessage('')
        setReplyQuestionId('')
        setTargetPlayerId('')
        return next
      })
      return
    }
    if(selectedTarget&&actions.has('ASK_PLAYER')){
      await act(async()=>{
        const next=await post('/actions/question',{
          commandId:commandId(),
          targetPlayerId:selectedTarget.id,
          question:content,
        })
        setMessage('')
        setTargetPlayerId('')
        setReplyQuestionId('')
        setMentionOpen(false)
        return next
      })
      return
    }
    if(actions.has('SEND_MESSAGE')){
      await act(async()=>{
        const next=await post('/actions/message',{commandId:commandId(),content})
        setMessage('')
        return next
      })
    }
  }

  if(!room){
    return <Landing
      scripts={scripts}
      selectedScript={selectedScript}
      scriptId={scriptId}
      busy={busy}
      savedRooms={savedRooms}
      roomRefs={roomRefs}
      onScript={setScriptId}
      onCreate={createRoom}
      onResume={resumeRoom}
      onForget={removeRoom}
      onImport={importScript}
      error={error}
    />
  }

  if(room.status==='lobby'){
    return <RoleSelection room={room} busy={busy} leave={leaveLocal} error={error}
      selectRole={roleId=>act(()=>post('/select-role',{roleId}))}
      start={()=>act(()=>post('/start'))}/>
  }

  if(room.status==='completed'){
    return <ReviewShell
      room={room}
      active={reviewTab}
      roleId={reviewRoleId}
      onTab={setReviewTab}
      onRole={setReviewRoleId}
      leave={leaveLocal}
      error={error}
    />
  }

  return <div className="game-shell">
    <GameHeader room={room} leave={leaveLocal} onPeople={()=>setPlayerSheet(room.me??room.players[0]??null)}/>

    <aside className="game-sidebar">
      <IdentityCard room={room}/>
      <div className="sidebar-divider"/>
      <PlayerRail room={room} busy={busy} onPlayer={setPlayerSheet}
        onNudge={playerId=>act(()=>post('/actions/nudge',{targetPlayerId:playerId}))}/>
    </aside>

    <nav className="game-tabs" aria-label="游戏信息">
      {GAME_TABS.map(tab=><button key={tab.id} className={activeTab===tab.id?'active':''} onClick={()=>setActiveTab(tab.id)}>
        <span className="tab-mark">{tab.short}</span><span>{tab.label}</span>
        {tab.id==='clues'&&room.privateClues.length>0&&<i>{room.privateClues.length}</i>}
      </button>)}
    </nav>

    <section className="game-stage">
      <div className="stage-head">
        <StageTitle tab={activeTab} room={room}/>
        {activeTab==='chat'&&<div className="round-status-dock">
          <RoundStatusStrip room={room} busy={busy}
            onNudge={playerId=>act(()=>post('/actions/nudge',{targetPlayerId:playerId}))}/>
        </div>}
      </div>

      <div className="stage-panels">
        <TabPanel active={activeTab==='chat'} className="chat-panel">
          <ChatView room={room} onPlayer={player=>setPlayerSheet(player)}
            onReplyQuestion={question=>{
              setReplyQuestionId(question.id)
              setTargetPlayerId(question.fromPlayerId)
              setMessage('')
            }}/>
        </TabPanel>

        <TabPanel active={activeTab==='clues'}>
          <CluesView room={room} tab={clueTab} setTab={setClueTab} busy={busy} actions={actions}
            reveal={holdingId=>act(()=>post('/actions/reveal-clue',{commandId:commandId(),holdingId}))}
            keep={holdingId=>act(()=>post('/actions/keep-clue-private',{commandId:commandId(),holdingId}))}/>
        </TabPanel>

        <TabPanel active={activeTab==='role'}>
          <RoleView room={room} tab={roleTab} setTab={setRoleTab}/>
        </TabPanel>

        <TabPanel active={activeTab==='story'}>
          <StoryView room={room} onPlayer={setPlayerSheet}/>
        </TabPanel>

        <TabPanel active={activeTab==='progress'}>
          <ProgressView room={room}/>
        </TabPanel>
      </div>

      <ActionDock
        room={room}
        activeTab={activeTab}
        actions={actions}
        busy={busy}
        message={message}
        target={selectedTarget}
        mentionOpen={mentionOpen}
        replyQuestion={replyQuestion}
        voteTarget={voteTarget}
        onMessage={setMessage}
        onToggleMention={()=>setMentionOpen(value=>!value)}
        onTarget={playerId=>{setTargetPlayerId(playerId);setReplyQuestionId('');setMentionOpen(false)}}
        onClearTarget={()=>{setTargetPlayerId('');setReplyQuestionId('')}}
        onSend={sendComposer}
        onFinishRound={()=>act(()=>post('/actions/finish-round',{commandId:commandId()}))}
        onSearch={searchLocation}
        onFinishSearch={()=>act(()=>post('/actions/finish-search',{commandId:commandId()}))}
        onVoteTarget={setVoteTarget}
        onVote={()=>act(()=>post('/actions/vote',{commandId:commandId(),targetRoleId:voteTarget}))}
        onOpenChat={()=>setActiveTab('chat')}
      />
    </section>

    <nav className="mobile-tabs" aria-label="移动端导航">
      {GAME_TABS.map(tab=><button key={tab.id} className={activeTab===tab.id?'active':''} onClick={()=>setActiveTab(tab.id)}>
        <span>{tab.short}</span><small>{tab.label}</small>
        {tab.id==='clues'&&room.privateClues.length>0&&<i>{room.privateClues.length}</i>}
      </button>)}
    </nav>

    {playerSheet&&<PlayerSheet room={room} player={playerSheet} close={()=>setPlayerSheet(null)}
      ask={player=>{
        setPlayerSheet(null)
        setActiveTab('chat')
        setTargetPlayerId(player.id)
      }}/>}
    {error&&<ErrorBar text={error}/>}
  </div>
}

function Landing({scripts,selectedScript,scriptId,busy,savedRooms,roomRefs,onScript,onCreate,onResume,onForget,onImport,error}:{
  scripts:ScriptSummary[]
  selectedScript?:ScriptSummary
  scriptId:string
  busy:boolean
  savedRooms:RoomView[]
  roomRefs:SavedRoomRef[]
  onScript:(value:string)=>void
  onCreate:()=>void
  onResume:(ref:SessionRef)=>void
  onForget:(ref:SessionRef)=>void|Promise<void>
  onImport:(file:File)=>void|Promise<void>
  error:string
}){
  return <main className="landing">
    <div className="landing-glow"/>
    <header className="brand-lockup">
      <span className="brand-seal">剧</span>
      <div><b>AI MURDER MYSTERY</b><small>AI 剧本推理局</small></div>
    </header>

    <section className="landing-copy">
      <span className="kicker">IMMERSIVE MYSTERY · PLAYER AGENTS</span>
      <h1>入局之后，<br/>每个人都有秘密。</h1>
      <p>和独立 AI 玩家一起搜证、质询、隐瞒、推理。公开信息属于整桌，秘密只属于角色自己。</p>
    </section>

    <section className="create-card">
      {savedRooms.length>0&&<div className="saved-room-section">
        <div className="section-label">继续游戏</div>
        <div className="saved-room-list">
          {savedRooms.map(saved=>{
            const ref=roomRefs.find(item=>item.roomId===saved.id&&item.playerId===saved.me?.id)
            if(!ref)return null
            const roundIndex=saved.currentRound?.index??0
            const total=Math.max(saved.roundPlan.length,1)
            const progress=saved.status==='completed'?100:Math.min(100,Math.round(((roundIndex+1)/total)*100))
            return <article className="saved-room-card" key={saved.id}>
              <div className="saved-room-main">
                <span>{saved.status==='completed'?'已完成':saved.status==='lobby'?'待开始':'进行中'}</span>
                <strong>{saved.script.title}</strong>
                <p>{saved.me?.roleName??'尚未选择角色'} · 房间 {saved.id.slice(0,8).toUpperCase()}</p>
                <div className="saved-room-progress"><i style={{width:progress+'%'}}/></div>
                <small>{saved.status==='completed'?'案件已复盘':saved.status==='lobby'?'等待选择角色':roundLabel(saved.currentRound?.title)} · {progress}%</small>
              </div>
              <div className="saved-room-actions">
                <button className="dark-small" onClick={()=>onResume(ref)}>继续</button>
                <button className="ghost-small" disabled={busy} onClick={()=>void onForget(ref)}>移除房间</button>
              </div>
            </article>
          })}
        </div>
        <div className="saved-room-separator"><span>开始新游戏</span></div>
      </div>}

      <div className="script-library-head">
        <div>
          <div className="section-label">01 · 剧本库</div>
          <p>选择一个剧本后，再创建新的推理房间。</p>
        </div>
        <label className="import-script-button">
          <span>＋</span> 导入 ZIP
        <input type="file" accept=".zip,application/zip" hidden disabled={busy}
          onChange={event=>{const file=event.target.files?.[0];if(file)void onImport(file);event.currentTarget.value=''}}/>
        </label>
      </div>
      <div className="script-choice">
        {scripts.map(script=><button key={script.id} className={scriptId===script.id?'selected':''} onClick={()=>onScript(script.id)}>
          <div><span>{script.playerCount} 人本</span><small>v{script.version}</small></div>
          <strong>{script.title}</strong>
          <p>{script.description}</p>
        </button>)}
      </div>
      {!scripts.length&&<Empty title="暂无剧本" text="导入符合剧本包规范的 ZIP 后，即可创建新的推理房间。"/>}
      {selectedScript&&<div className="selected-script-preview">
        <div className="section-label">02 · 剧本简介</div>
        <strong>{selectedScript.title}</strong>
        {selectedScript.publicContext&&<p className="story-preview">{selectedScript.publicContext}</p>}
      </div>}
      <button className="ink-button" disabled={busy||!selectedScript} onClick={onCreate}>
        创建新房间 <span>→</span>
      </button>
    </section>
    {error&&<ErrorBar text={error}/>}
  </main>
}

function RoleSelection({room,busy,leave,error,selectRole,start}:{
  room:RoomView
  busy:boolean
  leave:()=>void
  error:string
  selectRole:(id:string)=>void
  start:()=>void
}){
  return <main className="selection-shell">
    <header className="selection-head">
      <div><span className="kicker">ROLE CASTING</span><h1>{room.script.title}</h1><p>选择你要进入的人生。这里只展示公开身份。</p></div>
      <button className="ghost-button" onClick={leave}>退出房间</button>
    </header>
    <div className="selection-grid">
      {room.roleCards?.map((role,index)=>{
        const selected=room.me?.roleId===role.id
        const occupied=Boolean(role.selectedByPlayerId&&!selected)
        return <button key={role.id} className={'role-choice '+(selected?'selected ':'')+(occupied?'occupied':'')}
          disabled={busy||occupied} onClick={()=>selectRole(role.id)}>
          <span className="role-number">{String(index+1).padStart(2,'0')}</span>
          <div className="role-meta">{role.age} · {role.gender}</div>
          <h2>{role.name}</h2>
          <b>{role.occupation}</b>
          <p>{role.publicProfile}</p>
          <small>{occupied?'已被选择':selected?'你的角色':'选择角色'}</small>
        </button>
      })}
    </div>
    <footer className="selection-foot">
      <div>{room.me?.roleId?'角色已确认。开始后将解锁你的私人剧本。':'先选择一个角色。'}</div>
      <button className="ink-button" disabled={busy||!room.me?.roleId} onClick={start}>确认身份，进入案件 <span>→</span></button>
    </footer>
    {error&&<ErrorBar text={error}/>}
  </main>
}

function GameHeader({room,leave,onPeople}:{room:RoomView;leave:()=>void;onPeople:()=>void}){
  return <header className="game-header">
    <div className="header-brand"><span className="brand-seal small">剧</span><div><strong>{room.script.title}</strong><small>ROOM · {room.id.slice(0,8).toUpperCase()}</small></div></div>
    <div className="round-chip">
      <span className="live-dot"/><strong>{roundLabel(room.currentRound?.title)}</strong>
      <small>{roundModeLabel(room.currentRound?.mode)}</small>
    </div>
    <div className="header-actions">
      <button className="icon-button people-button" onClick={onPeople} aria-label="查看玩家">六人局</button>
      <button className="icon-button" onClick={leave}>退出</button>
    </div>
  </header>
}

function IdentityCard({room}:{room:RoomView}){
  const me=room.me
  const role=room.privateRole
  return <div className="identity-card">
    <span className="identity-index">{String(me?.seatNo??0).padStart(2,'0')}</span>
    <div className="identity-avatar">{role?.name.slice(0,1)??'?'}</div>
    <h2>{role?.name??'未知角色'}</h2>
    <p>{room.publicRoles.find(item=>item.id===me?.roleId)?.occupation??''}</p>
    <span className="private-badge">仅你可见</span>
    <div className="identity-stats">
      <div><small>私有线索</small><strong>{room.privateClues.length}</strong></div>
      <div><small>本轮状态</small><strong className="status-value">{roundStatusLabel(me?.roundStatus)}</strong></div>
    </div>
  </div>
}

function PlayerRail({room,busy,onPlayer,onNudge}:{
  room:RoomView
  busy:boolean
  onPlayer:(player:RoomPlayerView)=>void
  onNudge:(playerId:string)=>void
}){
  return <div className="player-rail">
    <div className="rail-title">同桌玩家 <span>{room.players.length}/6</span></div>
    {room.players.map(player=><div key={player.id} className={'player-row '+(player.id===room.me?.id?'me':'')}>
      <button className="player-main" onClick={()=>onPlayer(player)}>
        <span className="seat">{player.seatNo}</span>
        <span className="player-name">
          <strong>{player.roleName}</strong>
          <small>{roundStatusLabel(player.roundStatus)}</small>
        </span>
        <i className={'status-dot '+(player.roundStatus??'waiting')}/>
      </button>
      {player.canNudge&&<button className="nudge-button" disabled={busy} onClick={()=>onNudge(player.id)}>催</button>}
    </div>)}
  </div>
}

function StageTitle({tab,room}:{tab:GameTab;room:RoomView}){
  const map:Record<GameTab,{title:string;desc:string}>={
    chat:{title:'公开群聊',desc:'所有公开发言、定向质询与系统事件'},
    clues:{title:'线索桌',desc:'公开证据与只属于你的未公开线索'},
    role:{title:'我的角色',desc:'你的经历、秘密、目标与人物关系'},
    story:{title:'案件档案',desc:'所有玩家共同知道的故事背景与公开身份'},
    progress:{title:'游戏进程',desc:'当前所在轮次、已完成阶段与下一步'},
  }
  return <div><span className="kicker">CASE FILE · PUBLIC V{room.sharedVersion}</span><h1>{map[tab].title}</h1><p>{map[tab].desc}</p></div>
}

function TabPanel({active,className='',children}:{active:boolean;className?:string;children:React.ReactNode}){
  return <div className={'tab-panel '+className+(active?' active':'')} aria-hidden={!active}>{children}</div>
}

function ChatView({room,onPlayer,onReplyQuestion}:{
  room:RoomView
  onPlayer:(player:RoomPlayerView)=>void
  onReplyQuestion:(question:PendingQuestionView)=>void
}){
  const useful=room.publicTimeline.filter(event=>[
    'room_started','round_started','round_completed','message_sent','question_asked','question_replied',
    'clue_revealed','discussion_pacing_reminder','game_completed',
  ].includes(event.type))
  return <div className="chat-stream">
    <div className="case-thread-start">
      <span>公开频道</span><p>所有公开发言与 @ 提问都在这里发生。</p>
    </div>
    {useful.map(event=><ChatEvent key={event.id} event={event} room={room}
      onPlayer={onPlayer} onReplyQuestion={onReplyQuestion}/>)}
    {!useful.length&&<Empty title="还没有人开口" text="第一条公开发言会出现在这里。"/>}
  </div>
}

function RoundStatusStrip({room,busy,onNudge}:{room:RoomView;busy:boolean;onNudge:(playerId:string)=>void}){
  return <div className="round-status-strip">
    {room.players.map(player=><div key={player.id} className={'round-player '+(player.roundStatus??'waiting')}>
      <span className="round-player-avatar">{player.roleName?.slice(0,1)??'?'}</span>
      <div><strong>{player.roleName}</strong><small>{roundStatusLabel(player.roundStatus)}</small></div>
      {player.canNudge&&<button disabled={busy} onClick={()=>onNudge(player.id)}>催促</button>}
    </div>)}
  </div>
}

function ChatEvent({event,room,onPlayer,onReplyQuestion}:{
  event:PublicTimelineEvent
  room:RoomView
  onPlayer:(player:RoomPlayerView)=>void
  onReplyQuestion:(question:PendingQuestionView)=>void
}){
  const actor=room.players.find(player=>player.id===event.actorPlayerId)
  const target=room.players.find(player=>player.id===event.targetPlayerId)
  const pending=room.pendingQuestionsForMe.find(question=>question.sourceEventId===event.id)
  if(['room_started','round_started','round_completed','clue_revealed','discussion_pacing_reminder','game_completed'].includes(event.type)){
    return <div className={'system-event '+event.type}>
      <span>{systemEventIcon(event.type)}</span>
      <div><strong>{systemEventTitle(event)}</strong><p>{systemEventText(event)}</p></div>
      <small>#{event.seq}</small>
    </div>
  }

  const content=String(event.payload.content??'')
  const isQuestion=event.type==='question_asked'
  const isReply=event.type==='question_replied'
  return <article className={'chat-message '+event.type+(pending?' mention-me':'')}>
    <button className="message-avatar" onClick={()=>actor&&onPlayer(actor)}>{actor?.roleName?.slice(0,1)??'?'}</button>
    <div className="message-body">
      <div className="message-meta">
        <button onClick={()=>actor&&onPlayer(actor)}>{event.actorName??'未知玩家'}</button>
        <span>{actor?.roleName??''}</span><small>#{event.seq}</small>
      </div>
      <div className="message-line">
        <p className="message-copy">
          {(isQuestion||isReply)&&target&&<strong className="inline-mention">@{target.roleName} </strong>}
          {content}
        </p>
        {pending&&<button className="inline-reply-button" onClick={()=>onReplyQuestion(pending)}>回复</button>}
      </div>
    </div>
  </article>
}

function CluesView({room,tab,setTab,busy,actions,reveal,keep}:{
  room:RoomView
  tab:ClueTab
  setTab:(tab:ClueTab)=>void
  busy:boolean
  actions:Set<string>
  reveal:(id:string)=>void
  keep:(id:string)=>void
}){
  const clues=tab==='public'?room.publicClues:room.privateClues
  return <div className="info-view">
    <Segmented items={[
      {id:'public',label:`公开线索 · ${room.publicClues.length}`},
      {id:'private',label:`我的线索 · ${room.privateClues.length}`},
    ]} active={tab} onChange={value=>setTab(value as ClueTab)}/>
    <div className="clue-grid">
      {clues.map((clue,index)=><ClueCard key={clue.holdingId} clue={clue} index={index+1} privateMode={tab==='private'}
        busy={busy} canReveal={actions.has('REVEAL_CLUE')} canKeep={actions.has('KEEP_CLUE_PRIVATE')}
        reveal={()=>reveal(clue.holdingId)} keep={()=>keep(clue.holdingId)}/>)}
    </div>
    {!clues.length&&<Empty title={tab==='public'?'还没有公开线索':'你还没有私有线索'}
      text={tab==='public'?'公开后的证据会成为整桌共享信息。':'搜证得到且未公开的信息，只会出现在这里。'}/>}
  </div>
}

function ClueCard({clue,index,privateMode,busy,canReveal,canKeep,reveal,keep}:{
  clue:ClueView
  index:number
  privateMode:boolean
  busy:boolean
  canReveal:boolean
  canKeep:boolean
  reveal:()=>void
  keep:()=>void
}){
  return <article className={'evidence-card '+(privateMode?'private-evidence':'')}>
    <div className="evidence-top"><span>{String(index).padStart(2,'0')}</span><b>{privateMode?'PRIVATE':'PUBLIC'}</b></div>
    <h3>{clue.title}</h3>
    <p>{clue.content}</p>
    <small>来源 · {locationLabel(clue.locationId)}</small>
    {privateMode&&(canReveal||canKeep)&&<div className="evidence-actions">
      {canKeep&&<button disabled={busy} onClick={keep}>暂不公开</button>}
      {canReveal&&<button className="dark-small" disabled={busy} onClick={reveal}>公开给所有人</button>}
    </div>}
  </article>
}

function RoleView({room,tab,setTab}:{room:RoomView;tab:RoleTab;setTab:(tab:RoleTab)=>void}){
  const role=room.privateRole
  if(!role)return <Empty title="角色信息尚未解锁" text="游戏开始后才能阅读自己的私人剧本。"/>
  const profile=room.publicRoles.find(item=>item.id===role.roleId)
  return <div className="role-view info-view">
    <div className="role-hero">
      <div className="role-monogram">{role.name.slice(0,1)}</div>
      <div><span className="private-badge">PRIVATE CHARACTER FILE</span><h2>{role.name}</h2><p>{profile?.age}岁 · {profile?.gender} · {profile?.occupation}</p></div>
    </div>
    <Segmented items={[
      {id:'story',label:'角色故事'},
      {id:'facts',label:'已知事实'},
      {id:'secrets',label:'秘密'},
      {id:'goals',label:'目标'},
      {id:'relations',label:'关系'},
    ]} active={tab} onChange={value=>setTab(value as RoleTab)}/>
    <div className="role-document">
      {tab==='story'&&<><h3>你的经历</h3><p className="long-copy">{role.privateStory}</p></>}
      {tab==='facts'&&<DocumentList title="你确认知道的事实" values={role.knownFacts}/>}
      {tab==='secrets'&&<DocumentList title="只属于你的秘密" values={role.secrets} secret/>}
      {tab==='goals'&&<DocumentList title="你想完成的事" values={role.goals} goals/>}
      {tab==='relations'&&<DocumentList title="你与其他人的关系" values={role.relationships}/>}
    </div>
  </div>
}

function StoryView({room,onPlayer}:{room:RoomView;onPlayer:(player:RoomPlayerView)=>void}){
  return <div className="info-view story-view">
    <section className="story-document">
      <span className="document-no">CASE / {room.script.id.toUpperCase()}</span>
      <h2>{room.script.title}</h2>
      <p>{room.script.publicContext}</p>
    </section>
    <section>
      <SectionTitle title="公开人物" caption="所有玩家都知道这些身份"/>
      <div className="public-role-grid">
        {room.publicRoles.map((role,index)=>{
          const player=room.players.find(item=>item.roleId===role.id)
          return <button key={role.id} onClick={()=>player&&onPlayer(player)}>
            <span>{String(index+1).padStart(2,'0')}</span><h3>{role.name}</h3><b>{role.occupation}</b><p>{role.publicProfile}</p>
          </button>
        })}
      </div>
    </section>
    <section>
      <SectionTitle title="案件地点" caption="搜证阶段可以进入的空间"/>
      <div className="location-list">
        {room.locations.map(location=><article key={location.id}><span>⌖</span><div><h3>{location.name}</h3><p>{location.description}</p></div></article>)}
      </div>
    </section>
  </div>
}

function ProgressView({room}:{room:RoomView}){
  const currentIndex=room.currentRound?.index??room.roundPlan.length
  return <div className="info-view progress-view">
    <div className="progress-summary">
      <span className="kicker">CASE PROGRESS</span>
      <h2>{currentIndex+1}<small> / {room.roundPlan.length}</small></h2>
      <p>每一轮由剧本规则推进。讨论轮需要所有玩家在最新公共信息上确认“没有补充”后才会结束。</p>
    </div>
    <div className="round-timeline">
      {room.roundPlan.map(round=>{
        const isCurrent=room.currentRound?.index===round.index
        const complete=round.index<currentIndex
        return <article key={round.id} className={isCurrent?'current':complete?'complete':''}>
          <span className="round-node">{complete?'✓':String(round.index+1).padStart(2,'0')}</span>
          <div><small>{roundTypeLabel(round.type)}</small><h3>{roundLabel(round.title)}</h3>
            <p>{roundDescription(round.type,round.mode)}</p></div>
          {isCurrent&&<b>进行中</b>}
        </article>
      })}
    </div>
  </div>
}

function ActionDock(props:{
  room:RoomView
  activeTab:GameTab
  actions:Set<string>
  busy:boolean
  message:string
  target:RoomPlayerView|null
  mentionOpen:boolean
  replyQuestion:PendingQuestionView|null
  voteTarget:string
  onMessage:(value:string)=>void
  onToggleMention:()=>void
  onTarget:(id:string)=>void
  onClearTarget:()=>void
  onSend:()=>void
  onFinishRound:()=>void
  onSearch:(id:string)=>void
  onFinishSearch:()=>void
  onVoteTarget:(id:string)=>void
  onVote:()=>void
  onOpenChat:()=>void
}){
  const {room,actions,busy}=props
  const round=room.currentRound
  if(!round)return null

  if(round.type==='discussion'){
    const isIntroduction=round.requiredAction==='introduce'
    const canTalk=actions.has('SEND_MESSAGE')||actions.has('ASK_PLAYER')||actions.has('REPLY_QUESTION')
    const done=room.me?.roundStatus==='done'
    const targetLabel=props.replyQuestion?.fromName??props.target?.roleName
    return <div className="action-dock">
      {canTalk?<div className={'composer-dock '+(isIntroduction?'intro-composer':'')}>
        {targetLabel&&<div className="direct-target">
          <span>{props.replyQuestion?'正在回复':'正在向'}</span>
          <strong>@{targetLabel}</strong>
          <button onClick={props.onClearTarget}>×</button>
        </div>}
        {!isIntroduction&&props.mentionOpen&&<MentionPicker room={room} onTarget={props.onTarget}/>}
        {!isIntroduction&&<button className={'mention-button '+(props.target?'active':'')}
          disabled={!actions.has('ASK_PLAYER')} onClick={props.onToggleMention}>@</button>}
        <textarea rows={1} value={props.message} onChange={event=>props.onMessage(event.target.value)}
          placeholder={
            isIntroduction
              ? '轮到你时，公开介绍自己的身份与背景…'
              : props.replyQuestion
                ? `回复 @${props.replyQuestion.fromName}…`
                : props.target
                  ? `公开向 ${props.target.roleName} 提问…`
                  : '向所有玩家公开发言…'
          }
          onKeyDown={event=>{
            if(event.key==='Enter'&&!event.shiftKey&&props.message.trim()){
              event.preventDefault()
              props.onSend()
            }
          }}/>
        <button className="send-button" disabled={busy||!props.message.trim()} onClick={props.onSend}>
          {isIntroduction?'完成介绍':'发送'}
        </button>
        {!isIntroduction&&actions.has('FINISH_ROUND')&&<button className="finish-button" disabled={busy} onClick={props.onFinishRound}>结束本轮讨论</button>}
      </div>:<div className="waiting-dock">
        <span className="wait-mark">{done?'✓':'·'}</span>
        <div>
          <strong>{isIntroduction
            ? done?'你已完成自我介绍':'等待轮到你介绍'
            : done?'你已结束本轮讨论':'等待其他玩家行动'}</strong>
          <p>{isIntroduction
            ? '每个人必须公开介绍一次，六人完成后自动进入第一轮讨论。'
            : done?'本轮后续的新消息不会再要求你参与。':'可以在上方玩家状态中查看谁还没有结束本轮。'}</p>
        </div>
        {props.activeTab!=='chat'&&<button onClick={props.onOpenChat}>返回群聊</button>}
      </div>}
    </div>
  }

  if(round.type==='search'){
    return <div className="action-dock search-dock">
      <div className="dock-label"><span>搜证阶段</span><strong>选择一个地点</strong></div>
      <div className="search-locations">
        {room.locations.map(location=><button key={location.id} disabled={busy||!actions.has('SEARCH_CLUE')} onClick={()=>props.onSearch(location.id)}>
          <strong className="search-location-name">{location.name}</strong><small>{location.description}</small>
        </button>)}
      </div>
      {actions.has('FINISH_SEARCH')&&<button className="finish-button" disabled={busy} onClick={props.onFinishSearch}>结束我的搜证</button>}
    </div>
  }

  if(round.type==='vote'){
    return <div className="action-dock vote-dock">
      <div className="dock-label"><span>最终投票</span><strong>你的选择会密封保存</strong></div>
      <div className="vote-options">
        {room.players.map(player=><button key={player.id} className={props.voteTarget===player.roleId?'selected':''}
          disabled={!player.roleId||!actions.has('SUBMIT_VOTE')} onClick={()=>player.roleId&&props.onVoteTarget(player.roleId)}>
          <span>{player.seatNo}</span>{player.roleName}
        </button>)}
      </div>
      <button className="send-button" disabled={busy||!props.voteTarget||!actions.has('SUBMIT_VOTE')} onClick={props.onVote}>密封提交</button>
    </div>
  }

  return null
}

function MentionPicker({room,onTarget}:{room:RoomView;onTarget:(id:string)=>void}){
  return <div className="mention-picker">
    <span>选择要公开提问的玩家</span>
    {room.players.filter(player=>player.id!==room.me?.id).map(player=><button key={player.id} onClick={()=>onTarget(player.id)}>
      <i>{player.seatNo}</i><div><strong>{player.roleName}</strong></div><b>→</b>
    </button>)}
  </div>
}

function PlayerSheet({room,player,close,ask}:{room:RoomView;player:RoomPlayerView;close:()=>void;ask:(player:RoomPlayerView)=>void}){
  const role=room.publicRoles.find(item=>item.id===player.roleId)
  const isMe=player.id===room.me?.id
  return <div className="sheet-backdrop" onMouseDown={close}>
    <aside className="player-sheet" onMouseDown={event=>event.stopPropagation()}>
      <button className="sheet-close" onClick={close}>×</button>
      <span className="sheet-seat">{String(player.seatNo).padStart(2,'0')}</span>
      <div className="sheet-avatar">{role?.name.slice(0,1)??'?'}</div>
      <span className="kicker">{player.controller==='agent'?'AI PLAYER':'HUMAN PLAYER'}</span>
      <h2>{role?.name}</h2><b>{role?.age}岁 · {role?.gender} · {role?.occupation}</b>
      <p>{role?.publicProfile}</p>
      {!isMe&&room.currentRound?.type==='discussion'&&<button className="ink-button" onClick={()=>ask(player)}>向 {role?.name} 提问 <span>→</span></button>}
      <small>这里只展示所有人都知道的公开身份。</small>
    </aside>
  </div>
}

function ReviewShell({room,active,roleId,onTab,onRole,leave,error}:{
  room:RoomView
  active:ReviewTab
  roleId:string
  onTab:(tab:ReviewTab)=>void
  onRole:(id:string)=>void
  leave:()=>void
  error:string
}){
  return <div className="review-shell">
    <header className="review-header">
      <div className="header-brand"><span className="brand-seal small">终</span><div><strong>{room.script.title}</strong><small>CASE CLOSED · 真相复盘</small></div></div>
      <button className="ghost-button" onClick={leave}>离开复盘</button>
    </header>
    <aside className="review-aside">
      <span className="kicker">AFTER GAME</span>
      <h1>所有秘密，<br/>现在都可以看。</h1>
      <p>游戏中的信息隔离已经解除。你可以重新查看每个角色的真实经历、所有线索与整局公开时间线。</p>
      <div className="truth-stamp">CASE<br/>CLOSED</div>
    </aside>
    <nav className="review-tabs">
      {REVIEW_TABS.map(tab=><button key={tab.id} className={active===tab.id?'active':''} onClick={()=>onTab(tab.id)}>{tab.label}</button>)}
    </nav>
    <main className="review-stage">
      {active==='truth'&&<TruthReview room={room}/>}
      {active==='roles'&&<RolesReview room={room} roleId={roleId} onRole={onRole}/>}
      {active==='clues'&&<CluesReview room={room}/>}
      {active==='timeline'&&<TimelineReview room={room}/>}
      {active==='votes'&&<VotesReview room={room}/>}
    </main>
    {error&&<ErrorBar text={error}/>}
  </div>
}

function TruthReview({room}:{room:RoomView}){
  return <div className="review-scroll truth-review">
    <span className="kicker">THE TRUTH</span>
    <h1>凶手 · {room.result?.murdererName}</h1>
    <div className="truth-copy">{room.result?.truth}</div>
    <SectionTitle title="最终结论" caption="游戏结束后，剧本真相正式解除封存"/>
    <div className="truth-facts">
      <div><small>凶手角色</small><strong>{room.result?.murdererName}</strong></div>
      <div><small>公开线索</small><strong>{room.review?.clues.filter(clue=>clue.status==='public').length??0}</strong></div>
      <div><small>被私藏线索</small><strong>{room.review?.clues.filter(clue=>clue.status==='kept_private').length??0}</strong></div>
      <div><small>未发现线索</small><strong>{room.review?.clues.filter(clue=>clue.status==='undiscovered').length??0}</strong></div>
    </div>
  </div>
}

function RolesReview({room,roleId,onRole}:{room:RoomView;roleId:string;onRole:(id:string)=>void}){
  const roles=room.review?.roles??[]
  const role=roles.find(item=>item.roleId===roleId)??roles[0]
  if(!role)return <Empty title="没有角色资料" text="复盘数据不可用。"/>
  return <div className="review-split">
    <div className="review-role-list">
      {roles.map((item,index)=><button key={item.roleId} className={item.roleId===role.roleId?'active':''} onClick={()=>onRole(item.roleId)}>
        <span>{String(index+1).padStart(2,'0')}</span><div><strong>{item.name}</strong><small>{item.occupation}</small></div>
      </button>)}
    </div>
    <div className="review-role-document">
      <span className="kicker">FULL CHARACTER FILE</span>
      <h1>{role.name}</h1><b>{role.age}岁 · {role.gender} · {role.occupation}</b>
      <p className="public-note">{role.publicProfile}</p>
      <ReviewRoleSection title="真实经历" copy={role.privateStory}/>
      <ReviewRoleSection title="已知事实" list={role.knownFacts}/>
      <ReviewRoleSection title="秘密" list={role.secrets}/>
      <ReviewRoleSection title="目标" list={role.goals}/>
      <ReviewRoleSection title="人物关系" list={role.relationships}/>
    </div>
  </div>
}

function ReviewRoleSection({title,copy,list}:{title:string;copy?:string;list?:string[]}){
  return <section className="review-section"><h3>{title}</h3>{copy&&<p>{copy}</p>}{list&&<ul>{list.map(item=><li key={item}>{item}</li>)}</ul>}</section>
}

function CluesReview({room}:{room:RoomView}){
  const groups=[
    {status:'public',title:'本局已公开'},
    {status:'kept_private',title:'玩家持有但未公开'},
    {status:'undiscovered',title:'本局未发现'},
  ] as const
  return <div className="review-scroll">
    <span className="kicker">EVIDENCE ARCHIVE</span><h1>全部线索</h1>
    {groups.map(group=>{
      const clues=room.review?.clues.filter(clue=>clue.status===group.status)??[]
      return <section className="review-clue-group" key={group.status}>
        <SectionTitle title={group.title} caption={`${clues.length} 条`}/>
        <div className="review-clue-grid">
          {clues.map(clue=><ReviewClueCard key={clue.clueId} clue={clue}/>)}
        </div>
      </section>
    })}
  </div>
}

function ReviewClueCard({clue}:{clue:ReviewClueView}){
  return <article className={'review-clue '+clue.status}><span>{reviewClueStatus(clue.status)}</span><h3>{clue.title}</h3><p>{clue.content}</p>
    <small>{locationLabel(clue.locationId)}{clue.ownerName?` · 持有人 ${clue.ownerName}`:''}</small></article>
}

function TimelineReview({room}:{room:RoomView}){
  return <div className="review-scroll">
    <span className="kicker">PUBLIC EVENT LOG</span><h1>完整公开时间线</h1>
    <div className="review-timeline">
      {room.publicTimeline.map(event=>{
        const system=!event.actorName
        return <div key={event.id} className={'review-event '+(system?'system':'role-message')}>
          <span>#{event.seq}</span>
          <div>
            {system?<small className="review-system-label">系统</small>:<strong className="review-actor-name">{event.actorName}</strong>}
            <p>{timelineText(event)}</p>
          </div>
        </div>
      })}
    </div>
  </div>
}

function VotesReview({room}:{room:RoomView}){
  return <div className="review-scroll">
    <span className="kicker">SEALED VOTES · OPENED</span><h1>最终投票</h1>
    <div className="vote-review-grid">
      {room.result?.votes.map((vote,index)=><article key={vote.playerId}>
        <span>{String(index+1).padStart(2,'0')}</span><small>{vote.playerName}</small><div>→</div><strong>{vote.targetName}</strong>
      </article>)}
    </div>
  </div>
}

function Segmented({items,active,onChange}:{items:Array<{id:string;label:string}>;active:string;onChange:(id:string)=>void}){
  return <div className="segmented">{items.map(item=><button key={item.id} className={active===item.id?'active':''} onClick={()=>onChange(item.id)}>{item.label}</button>)}</div>
}

function DocumentList({title,values,secret=false,goals=false}:{title:string;values:string[];secret?:boolean;goals?:boolean}){
  return <div><h3>{title}</h3><div className={'document-list '+(secret?'secret-list ':'')+(goals?'goal-list':'')}>
    {values.map((value,index)=><article key={value}><span>{goals?'○':String(index+1).padStart(2,'0')}</span><p>{value}</p></article>)}
  </div></div>
}

function SectionTitle({title,caption}:{title:string;caption:string}){
  return <div className="section-title"><h2>{title}</h2><span>{caption}</span></div>
}

function Empty({title,text}:{title:string;text:string}){
  return <div className="empty-state"><span>·</span><h3>{title}</h3><p>{text}</p></div>
}

function ErrorBar({text}:{text:string}){return <div className="error-toast">{text}</div>}

function roundLabel(title?:string){ return title??'等待开始' }

function roundTypeLabel(type:string){
  return ({discussion:'讨论',search:'搜证',vote:'投票',reveal:'复盘'} as Record<string,string>)[type]??type
}

function roundStatusLabel(status?:RoomPlayerView['roundStatus']){
  if(status==='current')return '当前行动'
  if(status==='done')return '已结束'
  if(status==='needs_confirmation')return '待确认'
  if(status==='searching')return '搜证中'
  if(status==='search_done')return '搜证完成'
  if(status==='voted')return '已投票'
  return '等待中'
}

function roundModeLabel(mode?:string){
  if(mode==='ordered')return '依次行动'
  if(mode==='ordered_opportunity_then_free')return '依次机会 → 自由讨论'
  if(mode==='free')return '自由讨论'
  return ''
}

function roundDescription(type:string,mode?:string){
  if(type==='discussion')return mode==='free'?'自由发言、定向质询；所有玩家明确结束本轮后推进。':'按剧本规则获得行动机会。'
  if(type==='search')return '选择地点搜证；线索可能公开，也可能只属于持有人。'
  if(type==='vote')return '所有人独立密封提交最终判断。'
  if(type==='reveal')return '解除信息隔离，公布真相并进入复盘。'
  return ''
}

function locationLabel(id:string){ return id }

function systemEventIcon(type:string){
  if(type==='clue_revealed')return '证'
  if(type==='round_started')return '始'
  if(type==='round_completed')return '终'
  if(type==='discussion_pacing_reminder')return '控'
  if(type==='game_completed')return '真'
  return '局'
}

function systemEventTitle(event:PublicTimelineEvent){
  if(event.type==='clue_revealed')return `公开线索 · ${String(event.payload.title??'')}`
  if(event.type==='round_started')return roundLabel(String(event.payload.title??event.payload.roundDefinitionId??''))
  if(event.type==='round_completed')return `${roundLabel(String(event.payload.title??event.payload.roundDefinitionId??''))}结束`
  if(event.type==='discussion_pacing_reminder')return '控场提醒'
  if(event.type==='game_completed')return '案件结束'
  if(event.type==='room_started')return '游戏开始'
  return event.type
}

function systemEventText(event:PublicTimelineEvent){
  if(event.type==='clue_revealed')return String(event.payload.content??'')
  if(event.type==='round_started')return '新的阶段已经开始，所有玩家获得该阶段允许的行动。'
  if(event.type==='round_completed')return '所有完成条件已经满足，控场推进到下一阶段。'
  if(event.type==='discussion_pacing_reminder')return String(event.payload.content??'本轮讨论已持续较长时间，请适当收敛。')
  if(event.type==='game_completed')return '信息隔离已解除，可以进入完整复盘。'
  if(event.type==='room_started')return '所有角色就位，案件正式开始。'
  return ''
}

function timelineText(event:PublicTimelineEvent){
  if(event.type==='message_sent')return `${event.actorName}：${String(event.payload.content??'')}`
  if(event.type==='question_asked')return `${event.actorName} → @${event.targetName}：${String(event.payload.content??'')}`
  if(event.type==='question_replied')return `${event.actorName} 回应 ${event.targetName}：${String(event.payload.content??'')}`
  if(event.type==='question_declined')return `${event.actorName} 拒绝回答 ${event.targetName}`
  return `${systemEventTitle(event)} · ${systemEventText(event)}`
}

function reviewClueStatus(status:ReviewClueView['status']){
  if(status==='public')return '本局已公开'
  if(status==='kept_private')return '持有但未公开'
  return '本局未发现'
}

function humanizeError(code:string){
  const map:Record<string,string>={
    MODEL_NOT_CONFIGURED:'AI 模型尚未配置，当前房间无法启动。',
    NOT_ORDERED_TURN:'还没轮到你行动。',
    DUPLICATE_MESSAGE:'这句话和你上一条发言完全相同。',
    TOOL_NOT_ALLOWED_IN_ROUND:'当前阶段不能执行这个动作。',
    SEARCH_QUOTA_EXHAUSTED:'你的搜证次数已经用完。',
    NO_CLUE_AT_LOCATION:'这个地点目前没有可获得的新线索。',
    QUESTION_NOT_PENDING_FOR_PLAYER:'这个问题已经被处理，或不是发给你的。',
  }
  return map[code]??code
}
