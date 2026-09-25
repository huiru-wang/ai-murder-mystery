# Gameplay domain

`ScriptDefinition` fixes the roles, rounds, clues and final truth. A `Room` is one playthrough of one script. `RoomEvent` is an append-only public timeline, while private clues and sealed votes are projected only for their owning player.

`GameDirector` advances ordered introduction rounds only after every player has spoken. In free discussion, a player is complete only when it has finished at the latest public-state version and no pending question remains. New public information invalidates earlier completion. Human actions and AI tools both enter through `RoomCommandService`.
