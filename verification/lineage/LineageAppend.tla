------------------------------ MODULE LineageAppend ------------------------------
EXTENDS Naturals, Sequences

CONSTANT Clients

ASSUME Clients = {"A", "B"}

VARIABLES phase, lock, snapshotOps, snapshotHash, localOp, operations, topHash, returned

vars == <<phase, lock, snapshotOps, snapshotHash, localOp, operations, topHash, returned>>

Init ==
  /\ phase = [c \in Clients |-> "ready"]
  /\ lock = ""
  /\ snapshotOps = [c \in Clients |-> <<>>]
  /\ snapshotHash = [c \in Clients |-> "GENESIS"]
  /\ localOp = [c \in Clients |-> [id |-> "", actor |-> "", prev |-> ""]]
  /\ operations = <<>>
  /\ topHash = "GENESIS"
  /\ returned = 0

Acquire(c) ==
  /\ phase[c] = "ready"
  /\ lock = ""
  /\ phase' = [phase EXCEPT ![c] = "read"]
  /\ lock' = c
  /\ snapshotOps' = [snapshotOps EXCEPT ![c] = operations]
  /\ snapshotHash' = [snapshotHash EXCEPT ![c] = topHash]
  /\ UNCHANGED <<localOp, operations, topHash, returned>>

Compute(c) ==
  /\ phase[c] = "read"
  /\ lock = c
  /\ phase' = [phase EXCEPT ![c] = "computed"]
  /\ localOp' = [localOp EXCEPT ![c] =
      [id |-> Len(snapshotOps[c]) + 1,
       actor |-> c,
       prev |-> snapshotHash[c],
       hash |-> <<snapshotHash[c], c>>]]
  /\ UNCHANGED <<lock, snapshotOps, snapshotHash, operations, topHash, returned>>

Write(c) ==
  /\ phase[c] = "computed"
  /\ lock = c
  /\ phase' = [phase EXCEPT ![c] = "written"]
  /\ operations' = Append(snapshotOps[c], localOp[c])
  /\ topHash' = localOp[c].hash
  /\ returned' = returned + 1
  /\ lock' = ""
  /\ UNCHANGED <<snapshotOps, snapshotHash, localOp>>

Done ==
  /\ \A c \in Clients : phase[c] = "written"
  /\ lock = ""
  /\ UNCHANGED vars

Next ==
  \/ \E c \in Clients : Acquire(c)
  \/ \E c \in Clients : Compute(c)
  \/ \E c \in Clients : Write(c)
  \/ Done

Spec == Init /\ [][Next]_vars

NoLostSuccessfulAppend == Len(operations) = returned

ChainShape ==
  /\ Len(operations) <= 2
  /\ topHash = IF Len(operations) = 0
                 THEN "GENESIS"
                 ELSE operations[Len(operations)].hash

=============================================================================
