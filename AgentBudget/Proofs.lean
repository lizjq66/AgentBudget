import AgentBudget.Core

namespace AgentBudget

theorem advance_binding (e : Entry) (now : Nat) (a : Action) :
    (advance now a e).1.binding = e.binding := by
  cases h : e.phase <;> cases a <;> simp [advance, h]
  split <;> rfl

theorem edit_binding (b : Binding) (a : Action) (now : Nat) (e : Entry) :
    (edit b a now e).binding = e.binding := by
  unfold edit
  split
  · exact advance_binding e now a
  · rfl

theorem edit_terminal (b : Binding) (a : Action) (now : Nat) (e : Entry)
    (h : e.phase = .released ∨ e.phase = .settled) : edit b a now e = e := by
  unfold edit
  split
  · exact terminal_immutable e now a h
  · rfl

def lookup (s : State) (id : String) := s.entries.find? (fun e => e.binding.id == id)

theorem lookup_edit_terminal (s : State) (id : String) (e : Entry)
    (b : Binding) (a : Action) (now : Nat)
    (found : lookup s id = some e)
    (terminal : e.phase = .released ∨ e.phase = .settled) :
    lookup { s with entries := s.entries.map (edit b a now) } id = some e := by
  simp only [lookup, List.find?_map, Function.comp_def, edit_binding]
  change (lookup s id).map (edit b a now) = some e
  rw [found]
  simp [edit_terminal b a now e terminal]

theorem propose_terminal (s : State) (ev : Event) (id : String) (e : Entry)
    (found : lookup s id = some e)
    (terminal : e.phase = .released ∨ e.phase = .settled) :
    lookup (propose s ev).state id = some e := by
  cases ev with
  | inspect => exact found
  | cancel => exact found
  | reserve b expiry now =>
    simp only [propose]
    split <;> try exact found
    split <;> try exact found
    split <;> try exact found
    split <;> try exact found
    change (s.entries ++ [(⟨b, expiry, .reserved⟩ : Entry)]).find? (fun e => e.binding.id == id) = some e
    rw [List.find?_append]
    change (lookup s id).or _ = some e
    rw [found]
    rfl
  | apply b action now =>
    simp only [propose]
    split <;> try exact found
    split <;> try exact found
    exact lookup_edit_terminal s id e b action now found terminal

theorem step_terminal (s : State) (ev : Event) (id : String) (e : Entry)
    (found : lookup s id = some e)
    (terminal : e.phase = .released ∨ e.phase = .settled) :
    lookup (step s ev).state id = some e := by
  unfold step
  dsimp only
  split
  · exact propose_terminal s ev id e found terminal
  · exact found

-- The full manager, across arbitrary events for any other agents as well.
theorem run_terminal (events : List Event) (s : State) (id : String) (e : Entry)
    (found : lookup s id = some e)
    (terminal : e.phase = .released ∨ e.phase = .settled) :
    lookup (run s events) id = some e := by
  induction events generalizing s with
  | nil => exact found
  | cons ev es ih => exact ih _ (step_terminal s ev id e found terminal)

theorem released_never_inFlight (events : List Event) (s : State) (id : String) (e : Entry)
    (found : lookup s id = some e) (released : e.phase = .released) :
    (lookup (run s events) id).map Entry.phase = some .released := by
  rw [run_terminal events s id e found (Or.inl released)]
  simp [released]

theorem run_total (events : List Event) (s : State) : (run s events).total = s.total := by
  induction events generalizing s with
  | nil => rfl
  | cons ev es ih => exact (ih _).trans (step_total s ev)

theorem initial_budget_conserved (total : Nat) (events : List Event) :
    let s := run ⟨total, [], false⟩ events
    available s + reserved s + inFlight s + spent s = total := by
  dsimp only
  rw [all_sequences_conserve, run_total]

-- Idempotence of the actual entry transformation, even when the first event
-- is refused. The manager maps this function over matching immutable bindings.
theorem advance_paid_idempotent (e : Entry) (now later : Nat) :
    (advance later .paid (advance now .paid e).1).1 = (advance now .paid e).1 := by
  cases h : e.phase <;> simp [advance, h]

theorem advance_release_idempotent (e : Entry) (now later : Nat) :
    (advance later .release (advance now .release e).1).1 = (advance now .release e).1 := by
  cases h : e.phase <;> simp [advance, h]

theorem advance_unpaid_idempotent (e : Entry) (now later : Nat) :
    (advance later .unpaidFinal (advance now .unpaidFinal e).1).1 =
      (advance now .unpaidFinal e).1 := by
  cases h : e.phase <;> simp [advance, h]

theorem edit_final_idempotent (b : Binding) (e : Entry) (now later : Nat)
    (a : Action) (finalAction : a = .paid ∨ a = .release ∨ a = .unpaidFinal) :
    edit b a later (edit b a now e) = edit b a now e := by
  unfold edit
  by_cases matchBinding : e.binding == b
  · simp only [matchBinding, ite_true, advance_binding]
    rcases finalAction with h | h | h
    · subst a; exact advance_paid_idempotent e now later
    · subst a; exact advance_release_idempotent e now later
    · subst a; exact advance_unpaid_idempotent e now later
  · simp [matchBinding]

theorem ledger_final_idempotent (es : List Entry) (b : Binding) (now later : Nat)
    (a : Action) (finalAction : a = .paid ∨ a = .release ∨ a = .unpaidFinal) :
    (es.map (edit b a now)).map (edit b a later) = es.map (edit b a now) := by
  simp only [List.map_map, Function.comp_def]
  apply List.map_congr_left
  intro e _
  exact edit_final_idempotent b e now later a finalAction

-- Restarting from the exact committed prefix and applying the remaining
-- commands is identical to uninterrupted execution. Storage fidelity is an
-- external assumption; this theorem does not model SQLite or process I/O.
theorem replay_prefix_suffix (s : State) (before after : List Event) :
    run (run s before) after = run s (before ++ after) := by
  simp [run, List.foldl_append]

end AgentBudget
