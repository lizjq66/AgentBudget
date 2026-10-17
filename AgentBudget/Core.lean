import Std

namespace AgentBudget

inductive Phase where
  | reserved | inFlight | settled | released
  deriving Repr, BEq, DecidableEq

-- The binding is immutable, including the exact signed payload digest.
structure Binding where
  id : String
  agent : String
  amount : Nat
  network : String
  asset : String
  payTo : String
  digest : String
  deriving Repr, BEq, DecidableEq

structure Entry where
  binding : Binding
  expiresAt : Nat
  phase : Phase
  deriving Repr, BEq, DecidableEq

inductive Action where
  | handoff | release | paid | unpaidFinal | unknown
  deriving Repr, BEq, DecidableEq

-- unpaidFinal is an explicit trust boundary: the adapter attests both
-- "never paid" and "can no longer pay". Expiry alone is not this evidence.
def advance (now : Nat) (action : Action) (e : Entry) : Entry × Bool × String :=
  match e.phase, action with
  | .reserved, .handoff =>
    if now < e.expiresAt then
      ({ e with phase := .inFlight }, true, "authorization_permitted")
    else (e, false, "reservation_expired")
  | .reserved, .release => ({ e with phase := .released }, true, "released_before_handoff")
  | .inFlight, .paid => ({ e with phase := .settled }, true, "payment_confirmed")
  | .inFlight, .unpaidFinal => ({ e with phase := .released }, true, "final_nonpayment_evidence")
  | .settled, .paid => (e, true, "duplicate_confirmation")
  | .released, .release | .released, .unpaidFinal => (e, true, "duplicate_release")
  | .inFlight, .unknown => (e, true, "pending_confirmation")
  | .inFlight, .release => (e, false, "inflight_requires_final_nonpayment")
  | _, _ => (e, false, "invalid_transition")

def sumPhase (p : Phase) (es : List Entry) : Nat :=
  (es.map fun e => if e.phase == p then e.binding.amount else 0).sum

structure State where
  total : Nat
  entries : List Entry := []
  canceled : Bool := false
  deriving Repr, BEq, DecidableEq

def reserved (s : State) := sumPhase .reserved s.entries
def inFlight (s : State) := sumPhase .inFlight s.entries
def spent (s : State) := sumPhase .settled s.entries
def occupied (s : State) := reserved s + inFlight s + spent s
def available (s : State) := s.total - occupied s
def Valid (s : State) : Prop := occupied s ≤ s.total

inductive Event where
  | reserve (binding : Binding) (expiresAt now : Nat)
  | apply (binding : Binding) (action : Action) (now : Nat)
  | cancel
  | inspect
  deriving Repr

structure Reply where
  state : State
  allowed : Bool
  reason : String
  deriving Repr

def edit (b : Binding) (action : Action) (now : Nat) (old : Entry) : Entry :=
  if old.binding == b then (advance now action old).1 else old

def propose (s : State) (event : Event) : Reply := Id.run do
  match event with
  | .inspect => return ⟨s, true, "snapshot"⟩
  | .cancel => return ⟨{ s with canceled := true }, true, "new_reservations_disabled"⟩
  | .reserve b expiry now =>
    if s.canceled then return ⟨s, false, "task_canceled"⟩
    if b.amount == 0 then return ⟨s, false, "amount_must_be_positive"⟩
    if expiry ≤ now then return ⟨s, false, "invalid_reservation_expiry"⟩
    if s.entries.any (fun e => e.binding.id == b.id) then
      return ⟨s, false, "payment_id_already_bound"⟩
    return ⟨{ s with entries := s.entries ++ [⟨b, expiry, .reserved⟩] }, true, "reserved"⟩
  | .apply b action now =>
    match s.entries.find? (fun e => e.binding.id == b.id) with
    | none => return ⟨s, false, "unknown_payment_id"⟩
    | some e =>
      if e.binding != b then return ⟨s, false, "conflicting_payment_content"⟩
      let (_, ok, reason) := advance now action e
      return ⟨{ s with entries := s.entries.map (edit b action now) }, ok, reason⟩

-- This checked commit is part of the executable decision core, not an
-- assertion in the demo. It rejects over-budget proposals without mutation.
def step (s : State) (event : Event) : Reply :=
  let r := propose s event
  if occupied r.state ≤ s.total ∧ r.state.total = s.total then r
  else ⟨s, false, "insufficient_available_budget"⟩

def run (s : State) (events : List Event) : State :=
  events.foldl (fun s e => (step s e).state) s

theorem step_valid (s : State) (event : Event) (h : Valid s) :
    Valid (step s event).state := by
  unfold step
  dsimp only
  split
  next hcheck => unfold Valid; omega
  next => exact h

theorem step_total (s : State) (event : Event) :
    (step s event).state.total = s.total := by
  unfold step
  dsimp only
  split
  next h => exact h.2
  next => rfl

theorem run_valid (events : List Event) (s : State) (h : Valid s) :
    Valid (run s events) := by
  induction events generalizing s with
  | nil => exact h
  | cons e es ih => exact ih _ (step_valid s e h)

theorem initial_valid (total : Nat) : Valid ⟨total, [], false⟩ := by
  simp [Valid, occupied, reserved, inFlight, spent, sumPhase]

theorem conservation (s : State) (h : Valid s) :
    available s + reserved s + inFlight s + spent s = s.total := by
  unfold Valid occupied at h
  unfold available occupied
  omega

theorem all_sequences_conserve (total : Nat) (events : List Event) :
    let s := run ⟨total, [], false⟩ events
    available s + reserved s + inFlight s + spent s = s.total :=
  conservation _ (run_valid events _ (initial_valid total))

theorem terminal_immutable (e : Entry) (now : Nat) (a : Action)
    (h : e.phase = .released ∨ e.phase = .settled) :
    (advance now a e).1 = e := by
  rcases h with h | h <;> cases a <;> simp [advance, h]

theorem released_no_handoff (e : Entry) (now : Nat) (h : e.phase = .released) :
    (advance now .handoff e).2.1 = false ∧ (advance now .handoff e).1 = e := by
  simp [advance, h]

theorem duplicate_paid (e : Entry) (now : Nat) (h : e.phase = .settled) :
    advance now .paid e = (e, true, "duplicate_confirmation") := by
  simp [advance, h]

theorem duplicate_release (e : Entry) (now : Nat) (h : e.phase = .released) :
    advance now .release e = (e, true, "duplicate_release") := by
  simp [advance, h]

theorem terminal_sequence (actions : List (Nat × Action)) (e : Entry)
    (h : e.phase = .released ∨ e.phase = .settled) :
    actions.foldl (fun e p => (advance p.1 p.2 e).1) e = e := by
  induction actions with
  | nil => rfl
  | cons p ps ih =>
    simp only [List.foldl_cons, terminal_immutable e p.1 p.2 h]
    exact ih

end AgentBudget
