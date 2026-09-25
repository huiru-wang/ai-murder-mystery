import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class MurderMysteryDatabase {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    this.db.close()
  }

  private migrate() {
    this.db.exec(`
      create table if not exists rooms (
        id text primary key,
        script_version_id text not null,
        status text not null,
        current_round_instance_id text,
        shared_version integer not null default 0,
        last_event_seq integer not null default 0,
        runtime_revision text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists room_players (
        id text primary key,
        room_id text not null,
        seat_no integer not null,
        role_id text,
        controller text not null,
        display_name text not null,
        user_id text,
        agent_session_id text,
        status text not null,
        created_at text not null,
        foreign key(room_id) references rooms(id) on delete cascade,
        unique(room_id, seat_no),
        unique(room_id, role_id)
      );

      create table if not exists round_instances (
        id text primary key,
        room_id text not null,
        round_definition_id text not null,
        round_index integer not null,
        type text not null,
        status text not null,
        public_version_at_start integer not null,
        turn_order_json text not null,
        turn_index integer not null default 0,
        started_at text not null,
        completed_at text,
        foreign key(room_id) references rooms(id) on delete cascade,
        unique(room_id, round_index)
      );

      create table if not exists player_round_states (
        round_instance_id text not null,
        room_player_id text not null,
        last_seen_public_version integer not null default 0,
        done_at_public_version integer,
        discussion_finished integer not null default 0,
        activation_count integer not null default 0,
        initial_action_done integer not null default 0,
        search_actions_used integer not null default 0,
        search_finished integer not null default 0,
        updated_at text not null,
        primary key(round_instance_id, room_player_id),
        foreign key(round_instance_id) references round_instances(id) on delete cascade,
        foreign key(room_player_id) references room_players(id) on delete cascade
      );

      create table if not exists room_events (
        id text primary key,
        room_id text not null,
        round_instance_id text,
        seq integer not null,
        actor_player_id text,
        event_type text not null,
        visibility text not null,
        owner_player_id text,
        target_player_id text,
        payload_json text not null,
        created_at text not null,
        foreign key(room_id) references rooms(id) on delete cascade,
        foreign key(round_instance_id) references round_instances(id) on delete cascade,
        unique(room_id, seq)
      );

      create table if not exists clue_holdings (
        id text primary key,
        room_id text not null,
        room_player_id text not null,
        clue_id text not null,
        acquired_event_id text not null,
        state text not null,
        revealed_event_id text,
        created_at text not null,
        foreign key(room_id) references rooms(id) on delete cascade,
        foreign key(room_player_id) references room_players(id) on delete cascade,
        unique(room_id, room_player_id, clue_id)
      );

      create table if not exists pending_interactions (
        id text primary key,
        room_id text not null,
        round_instance_id text not null,
        interaction_type text not null,
        from_player_id text not null,
        to_player_id text not null,
        source_event_id text not null,
        status text not null,
        resolved_event_id text,
        created_at text not null,
        resolved_at text,
        foreign key(room_id) references rooms(id) on delete cascade,
        foreign key(round_instance_id) references round_instances(id) on delete cascade
      );

      create table if not exists votes (
        room_id text not null,
        round_instance_id text not null,
        room_player_id text not null,
        target_role_id text not null,
        reasoning text,
        submitted_at text not null,
        primary key(round_instance_id, room_player_id),
        foreign key(room_id) references rooms(id) on delete cascade,
        foreign key(round_instance_id) references round_instances(id) on delete cascade,
        foreign key(room_player_id) references room_players(id) on delete cascade
      );

      create table if not exists command_receipts (
        room_id text not null,
        command_id text not null,
        actor_player_id text,
        command_type text not null,
        result_json text not null,
        created_at text not null,
        primary key(room_id, command_id),
        foreign key(room_id) references rooms(id) on delete cascade
      );

      create table if not exists agent_sessions (
        id text primary key,
        room_id text not null,
        room_player_id text not null unique,
        runtime_session_id text not null unique,
        agent_revision text not null,
        last_run_at text,
        status text not null,
        foreign key(room_id) references rooms(id) on delete cascade,
        foreign key(room_player_id) references room_players(id) on delete cascade
      );

      create table if not exists agent_runs (
        id text primary key,
        agent_session_id text not null,
        round_instance_id text,
        trigger_type text not null,
        trigger_event_id text,
        started_at text not null,
        completed_at text,
        status text not null,
        tool_count integer not null default 0,
        token_usage_json text,
        foreign key(agent_session_id) references agent_sessions(id) on delete cascade
      );

      create index if not exists idx_room_events_room_seq on room_events(room_id, seq);
      create index if not exists idx_room_events_visibility on room_events(room_id, visibility, seq);
      create index if not exists idx_pending_target on pending_interactions(room_id, to_player_id, status);
      create index if not exists idx_player_round_state on player_round_states(round_instance_id, room_player_id);
    `)

    const roundStateColumns = this.db.prepare('pragma table_info(player_round_states)').all() as Array<{name:string}>
    if (!roundStateColumns.some(column => column.name === 'discussion_finished')) {
      this.db.exec('alter table player_round_states add column discussion_finished integer not null default 0')
    }

    const holdingSchema = this.db.prepare(
      "select sql from sqlite_master where type='table' and name='clue_holdings'"
    ).get() as {sql?: string}|undefined
    if (/unique\s*\(\s*room_id\s*,\s*clue_id\s*\)/i.test(holdingSchema?.sql ?? '')) {
      this.db.exec(`
        alter table clue_holdings rename to clue_holdings_legacy;
        create table clue_holdings (
          id text primary key,
          room_id text not null,
          room_player_id text not null,
          clue_id text not null,
          acquired_event_id text not null,
          state text not null,
          revealed_event_id text,
          created_at text not null,
          foreign key(room_id) references rooms(id) on delete cascade,
          foreign key(room_player_id) references room_players(id) on delete cascade,
          unique(room_id, room_player_id, clue_id)
        );
        insert into clue_holdings
          (id,room_id,room_player_id,clue_id,acquired_event_id,state,revealed_event_id,created_at)
        select id,room_id,room_player_id,clue_id,acquired_event_id,state,revealed_event_id,created_at
        from clue_holdings_legacy;
        drop table clue_holdings_legacy;
      `)
    }
  }
}
