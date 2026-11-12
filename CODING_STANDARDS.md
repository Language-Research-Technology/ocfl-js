# Coding standards

Conventions a reviewer checks. Anything the checks in [CONTRIBUTING.md](CONTRIBUTING.md#checks) enforce isn't repeated here.

## Types

- Prefer `interface … extends` to intersecting a type with an object literal (`type A = B & { … }`), unless an interface can't extend the base (a union, mapped, conditional or primitive type, or a type parameter). `extends` flags a clashing member at the declaration (an intersection silently makes it `never`) and keeps the name in hovers, errors and the API report.
