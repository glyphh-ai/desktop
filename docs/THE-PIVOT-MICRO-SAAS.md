# THE-PIVOT-MICRO-SAAS — positioning for the app platform

> Strategy notes distilled from the platform-v2 build session (July 2026).
> Sister docs: `GLYPHH-APP-SPEC.md` (the contract this positioning sells),
> `THE-PIVOT-GITHUB.md`, `THE-PIVOT-BYOK.md` (the pivots that made
> "no LLM, no keys, no agent in Glyphh" true).

---

## What we are

Glyphh hosts **apps on the user's machine** — native-feeling, web-built,
marketplace-delivered — that both the user and any LLM (Claude, Cursor,
anything speaking MCP) can drive. Apps get per-app SQLite / vectors /
Kuzu-Cypher graph, cron, notifications, OS capabilities, 3,500 user-scoped
connections, encrypted per-app config vars, and `agent.run` on the app's
own key. Glyphh itself has **no LLM, no key store, no agent**. Apps are the
only agentic surface.

---

## The angle vs. Claude-native apps / MCP apps (Figma-in-chat, etc.)

Chat-hosted apps are **session-scoped**: they live in a conversation pane,
sandboxed away from the machine, and stop existing when the tab closes.
That quadrant belongs to Anthropic (artifacts) and big SaaS buying chat
presence (MCP apps). We don't compete there. Our quadrant:

1. **Residency** — apps act while no conversation exists: cron fires at
   9am, OS notifications land, the app sits in the dock/layouts/palette.
2. **Hands** — Contacts, Messages, window control, files. A chat artifact
   cannot text your mom.
3. **Data gravity, locally** — months of accumulated per-app state (graphs,
   vectors) on-device. Switching costs without vendor lock-in.
4. **Model-agnosticism** — the same installed app serves Claude, Cursor,
   and the app's own agent. Anthropic will never ship neutrality; it's
   free for us.
5. **The connector fabric** — one OAuth per service, shared by every app
   and every external model.

Claude building apps natively is not the threat — it's the **supply
chain**. Claude is the build plane; Glyphh is the run plane. Flagship
demo: Claude builds a `.glyphh` mid-conversation, `app_install`s it, the
app appears with its schedule armed, and Claude uses its tools forever
after. *Claude builds it; Glyphh keeps it alive.* When MCP-UI matures,
adopt it as an additional surface: the app renders in chat AND lives
locally.

---

## The delivery model: SaaS unbundled

Classic SaaS bundles software + hosting + data custody + integrations.
We unbundle:

| layer         | where it lands                                   |
|---------------|--------------------------------------------------|
| software      | signed marketplace bundle (static files)          |
| hosting       | the user's machine (every customer brings compute)|
| data          | their existing SaaS (via connections) + local stores |
| integrations  | Glyphh connector fabric                           |
| intelligence  | the user's own model keys (per-app config vars)   |

**Builder economics:** SaaS revenue on shrinkwrap cost structure — zero
infra, zero COGS, zero uptime, and **zero data custody** (no SOC2, no DPA,
no breach surface; the vendor never sees a byte). Viable team size for a
real connected business app drops to one person — or one person's Claude.
License checks are one relay call, the model's only server touchpoint.

**User economics:** logic comes to the data instead of data being copied
to the vendor. Cancel an app and your data was never anywhere to retrieve.

**Our economics:** Glyphh runs the *rails* SaaS — marketplace cut, relay,
connector fabric. No inference costs, no data custody. Watch item: metered
Pipedream connector calls (a nightly cron sync app has real connector
COGS; price accordingly).

Weaknesses, eyes open: (a) marketplace trust is existential — signing,
review, manifest-as-nutrition-label ARE the product, like App Store review
is the iPhone's security model; (b) sync/collaboration is where real SaaS
still wins — don't pitch against team SaaS until there's a (user's-own-
machines) sync story.

---

## The category: identity-native glue

This doesn't kill SaaS — it **splits SaaS and kills the middle**. Systems
of record (Jira, GitHub, Salesforce) get MORE valuable: they stay the
shared truth, the collaboration substrate, and the ACL authority. The kill
zone is the layer above: dashboards, panes-of-glass, workflow glue,
departmental apps whose moat was "we integrated your stuff."

**The crown jewel: no service account, anywhere.** Every glue layer today
(Zapier, warehouses, iPaaS, BI) connects with god-mode credentials, copies
data, then fails to rebuild row-level security on top. Glyphh apps call
Jira as *the user*, on the user's OAuth — the source system's own ACLs are
the enforcement point, and there is no second copy where they could be
flattened. The tickets you can't see never arrive. Agents inherit the same
ceiling: `agent.run` drives tools through the same user-scoped
connections, so **an agent structurally cannot see more than its human**
— the answer to the confused-deputy problem, and every action lands in the
source SaaS's own audit log under the user's identity.

Naming: product noun = **Glyphh Apps** (keep it boring). Category =
**identity-native micro-SaaS** ("apps that glue your systems together and
can only ever see what you can see"). Tagline to test: *"Your SaaS is the
database. Glyphh is the app."*

Hardening roadmap (v3 spec candidate): **per-app connector action scoping**
— manifest declares not just `jira` but `jira: read-only`, so a rogue app
can't write with the user's identity even though the user can.

Risks: incumbents (Rovo, Agentforce, Copilot) want the glue seat — each is
suite-biased and is itself another cloud with the service-account problem,
but expect API-pricing/rate-limit squeezes on glue layers. Pipedream is a
single-vendor dependency; keep a contingency.

---

## Enterprise security: more secure or less?

Honest answer: **architecturally more secure, perceptually less familiar**
— and which one a company lands on depends on shipping a control plane.

More secure, structurally (no cloud agent can match):
- **Custody** — zero new data processors; the vendor-risk workstream
  doesn't exist.
- **Identity** — no service accounts; the agent's ceiling is the
  employee's ceiling.
- **Blast radius** — compromising one machine yields one employee's
  existing access (the laptop's blast radius today), not an Okta-shaped
  central breach of every tenant's connections.
- **Real baseline** — the alternative isn't "nothing," it's shadow AI:
  employees pasting customer lists into chatbots and personal Zapier.

Less secure, in the CISO's gut (and the gut isn't stupid):
- Marketplace apps executing on endpoints pattern-match to malware; an app
  that reads Contacts, sends Messages, and calls SaaS on a schedule is
  behaviorally an implant to an unbriefed EDR analyst.
- DLP/CASB can't see inside a local SQLite join.
- No standard assessment rubric exists ("sovereign agent runtime" isn't on
  the questionnaire), and unfamiliar defaults to *no*.

The synthesis: enterprises buy **controllable**, not "secure." Precedent:
the iPhone was rejected until App Store review + MDM existed, then adopted
at scale. The jujitsu: **the endpoint is the only place enterprises
already have a management stack** (MDM, EDR, device trust). Nothing
governs a third-party cloud agent platform except a contract. Say that in
every enterprise meeting.

Enterprise control-plane roadmap (the manifest is already the right
substrate — it becomes a policy object):
1. Org-managed catalog: private marketplace, allowlists, admin kill-switch.
2. Policy engine: org disables capabilities fleet-wide (`rpa.*`,
   `messages.send`), forces connector read-only.
3. Signed + reviewed bundles.
4. Central audit feed of capability calls (app + user attribution) for the
   SOC.
5. MDM distribution.

Sell **consumer/SMB on "more secure" today**; sell **enterprise on "more
controllable" tomorrow**. Never argue the abstract question — the answer
is "more secure than the cloud agents you're evaluating, less familiar
than the SaaS you're used to," and familiarity is a roadmap item, not an
architecture flaw. Their architecture can't be fixed with a feature.
