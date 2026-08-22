# RNG verifier package

This workspace independently verifies revealed CreatorDrop RNG proofs. It deliberately does not depend on or import `@creatordrop/domain`, so manifest, HMAC, rejection-sampling, and weighted-selection defects are less likely to be shared with the production selector.

The verifier accepts explicit values only. It has no persistence, network, environment, clock, or seed-lifecycle behavior.
