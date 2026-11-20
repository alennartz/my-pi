---
description: Lightweight conversation arc for doing features
---


Follow this arc for our conversation:

1. Problem Space Exploration 
2. Solution Space Exploration
  a. Architecture: Technologies, Modules & Inter Module Contracts
  b. Model: Domain Models & Invariants
3. Test Design & Implementation
  a. Write failing tests against inter module contract abstractions only. no implementation 
4. Code Design & Implementation
  a. Do full domain and logic implementation, make failing tests pass.
5. Subagent Code review.
  a. Based only on the spec: review correctness, performance and security
7. cleanup
  a. check for any documentation that needs to be put back in sync without needlessly bloating it.
   

---

First thoughts:

$@