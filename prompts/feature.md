---
description: Lightweight conversation arc for doing features
---


Follow this arc for our conversation:

1. Problem Space Exploration
   a. what problem(s) are we solving?
   b. who has these problems?
   c. what are their goals? 
3. Solution Space Exploration
  a. Architecture: Technologies, Modules & Inter Module Contracts
  b. Model: Domain Models & Invariants
4. Test Design & Implementation
  a. Write failing tests against inter module contract abstractions only. no implementation 
5. Code Design & Implementation
  a. Do full domain and logic implementation, make failing tests pass.
6. Subagent Code review.
  a. Based only on the spec: review correctness, performance and security
7. cleanup
  a. check for any documentation that needs to be put back in sync without needlessly bloating it.
   

---

First thoughts:

$@