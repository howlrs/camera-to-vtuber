# Sample avatar licenses

The VRM files in this directory are fetched by `npm run setup`:

- `VRM1_Constraint_Twist_Sample.vrm` and `Seed-san.vrm` from the VRM Consortium specification
  repository (`vrm-c/vrm-specification/samples`), licensed under the
  [VRM Public License 1.0](https://vrm.dev/licenses/1.0/). Permissions were read from the
  `VRMC_vrm.meta` block of each file.
- `Sakurada_Fumiriya.vrm` (桜田 史利矢, a male short-haired VRoid Studio alpha sample, VRM 0.x) from
  [OpenGameArt "VRoid Studio CC0 models"](https://opengameart.org/content/vroid-studio-cc0-models)
  (`sakurada_fumiriya.zip`), which lists it as CC0 ("explicitly released by VRoid under CC0").
  The file's own `VRM.meta` points to VRoid Hub conditions with the same effect (see below).

| File | Author | Avatar use | Commercial use | Modification | Redistribution | Credit |
| --- | --- | --- | --- | --- | --- | --- |
| `VRM1_Constraint_Twist_Sample.vrm` | (c) 2022 pixiv Inc. | everyone | corporation | allowModificationRedistribution | allowed | not required |
| `Seed-san.vrm` | VirtualCast, Inc. | everyone | corporation | allowModificationRedistribution | allowed | **required**: "Seed-san model by VirtualCast, Inc." |
| `Sakurada_Fumiriya.vrm` | VRoidプロジェクト | Everyone | allow (personal profit, corporate) | allow | allow | unnecessary |

Notes:

- `Sakurada_Fumiriya.vrm` meta: `licenseName: Other`, `otherLicenseUrl` = VRoid Hub license
  (`allowed_to_use_user=everyone`, `corporate_commercial_use=allow`, `personal_commercial_use=profit`,
  `modification=allow`, `redistribution=allow`, `credit=unnecessary`, violent/sexual expression allowed).

- `VRM1_Constraint_Twist_Sample` sets `allowAntisocialOrHateUsage: false`.
- The app shows the required credit for Seed-san in the bottom right of the stage whenever it is loaded.
- Textures restyled by the Gemini designer are modifications of these models; keep the credit when
  distributing a Seed-san derivative.
