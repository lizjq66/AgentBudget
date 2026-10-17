import AgentBudget
import Lean

open Lean AgentBudget

def network := "eip155:84532"
def asset := "0x036cbd53842c5426634e7929541ec2318f3dcf7e"

def str (j : Json) (key : String) : Except String String := do
  let v ← (← j.getObjVal? key).getStr?
  if v.isEmpty then throw s!"{key}: must not be empty"
  return v

def nat (j : Json) (key : String) : Except String Nat := do
  let v ← str j key
  if !v.toList.all Char.isDigit then throw s!"{key}: expected unsigned integer string"
  match v.toNat? with
  | some n => return n
  | none => throw s!"{key}: invalid integer"

def binding (j : Json) : Except String Binding := do
  let b ← j.getObjVal? "binding"
  let net ← str b "network"
  let token ← str b "asset"
  if net != network || token != asset then throw "unsupported_network_or_asset"
  return ⟨← str b "id", ← str b "agent", ← nat b "amount", net, token,
    ← str b "payTo", ← str b "digest"⟩

def event (j : Json) : Except String Event := do
  match ← str j "op" with
  | "reserve" => return .reserve (← binding j) (← nat j "expiresAt") (← nat j "now")
  | "cancel" => return .cancel
  | "inspect" => return .inspect
  | "handoff" => return .apply (← binding j) .handoff (← nat j "now")
  | "release" => return .apply (← binding j) .release (← nat j "now")
  | "paid" => return .apply (← binding j) .paid (← nat j "now")
  | "unpaidFinal" =>
    if (← str j "evidence") != "simulator:never-paid-and-disabled" then
      throw "missing_final_nonpayment_evidence"
    return .apply (← binding j) .unpaidFinal (← nat j "now")
  | "unknown" => return .apply (← binding j) .unknown (← nat j "now")
  | _ => throw "unknown_operation"

def js (s : String) := Json.str s
def jn (n : Nat) := js (toString n)
def phaseName : Phase → String
  | .reserved => "Reserved"
  | .inFlight => "InFlight"
  | .settled => "Settled"
  | .released => "Released"

def bindingJson (b : Binding) : Json := Json.mkObj [
  ("id", js b.id), ("agent", js b.agent), ("amount", jn b.amount),
  ("network", js b.network), ("asset", js b.asset), ("payTo", js b.payTo), ("digest", js b.digest)]

def snapshot (s : State) : Json := Json.mkObj [
  ("total", jn s.total), ("available", jn (available s)),
  ("reserved", jn (reserved s)), ("inFlight", jn (inFlight s)), ("spent", jn (spent s)),
  ("canceled", Json.bool s.canceled), ("entries", Json.arr (s.entries.toArray.map fun e =>
    Json.mkObj [("binding", bindingJson e.binding), ("expiresAt", jn e.expiresAt),
      ("phase", js (phaseName e.phase))]))]

def response (state : Option State) (ok : Bool) (reason : String) : Json := Json.mkObj [
  ("allowed", Json.bool ok), ("reason", js reason),
  ("state", state.map snapshot |>.getD Json.null)]

def handle (state : Option State) (line : String) : Option State × Json :=
  match (do
    let j ← Json.parse line
    let op ← str j "op"
    if op == "init" then
      if state.isSome then throw "already_initialized"
      let total ← nat j "total"
      let s : State := ⟨total, [], false⟩
      return (some s, response (some s) true "initialized")
    let s ← match state with
      | some s => pure s
      | none => throw "initialize_budget_first"
    let e ← event j
    let r := step s e
    return (some r.state, response (some r.state) r.allowed r.reason)
    : Except String (Option State × Json)) with
  | .ok r => r
  | .error err => (state, response state false s!"invalid_input: {err}")

def main : IO Unit := do
  let stdin ← IO.getStdin
  let stdout ← IO.getStdout
  let mut state : Option State := none
  repeat
    let line ← stdin.getLine
    if line.isEmpty then break
    let (next, output) := handle state line
    state := next
    stdout.putStrLn output.compress
    stdout.flush
