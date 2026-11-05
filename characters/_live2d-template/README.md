# Live2D 캐릭터 견본

이름이 `_`로 시작하는 폴더는 목록에 나오지 않는다. 이 폴더를 복사해서 이름을 바꿔 쓴다 (예: `my-characters/hana/` — 내가 만든 캐릭터는 `my-characters/`에 둔다. `characters/`는 앱에 같이 들어 있는 기본 캐릭터용이라 읽기 전용이다).

**더 쉬운 방법**: 설정 > 캐릭터 > ＋ 추가에서 "Live2D (모델 폴더)"를 고르고 모델 폴더(.model3.json이 든 폴더)를 고르면, 앱이 `<캐릭터>/model/`로 복사하고 `config.json`을 만든다. 입 파라미터(`LipSync` 그룹)와 `Idle` 모션은 모델 파일에서 읽어 채우고, 표정·나머지 모션과 목록 아이콘(`icon`)은 아래 표를 보고 `config.json`에서 직접 맞춘다.

```
characters/hana/
├── config.json
├── icon.png                  ← 목록 아이콘, Live2D를 못 불러올 때 대신 보일 그림
└── model/
    ├── hana.model3.json      ← config.json의 live2d.model
    ├── hana.moc3
    ├── hana.physics3.json
    ├── textures/…
    ├── expressions/*.exp3.json
    └── motions/*.motion3.json
```

Cubism 4 모델(`.model3.json`)만 지원한다. Cubism 2 모델(`.model.json`)은 안 된다.

## config.json의 `live2d` 항목

| 항목 | 뜻 | 찾는 곳 |
|---|---|---|
| `model` | 캐릭터 폴더 기준 `.model3.json` 경로 | 모델 폴더 |
| `scale`, `offsetX`, `offsetY` | 크기 배율, 위치 보정(픽셀). 기본은 화면 높이에 맞춰 아래 가운데 | 직접 맞춰 보기 |
| `params.mouthOpen` | 입 벌림 파라미터 ID. 립싱크가 이 값을 움직인다 | `.model3.json`의 `Groups` 중 `LipSync`, 또는 Cubism Viewer의 파라미터 목록. 대부분 `ParamMouthOpenY` |
| `expressions.neutral/happy/thinking` | 상태별 표정 이름 | `.model3.json`의 `FileReferences.Expressions[].Name` |
| `motions.idle/thinking/talking` | 상태별 모션 그룹 이름 | `.model3.json`의 `FileReferences.Motions`의 키 (예: `Idle`, `TapBody`) |

빈 문자열이면 그 상태에서 아무것도 바꾸지 않는다. 앱 코드는 `happy`, `thinking` 같은 공통 이름만 쓰고, 모델마다 다른 실제 이름은 여기서만 연결한다.

상태가 바뀌는 때:

- `thinking`: 메시지를 보내고 답을 기다리는 동안
- `talking`: 목소리를 재생하는 동안 (표정은 `happy`)
- `idle`: 그 밖 (표정은 `neutral`)

## 모델 사용 조건

Live2D 샘플 모델이나 구매한 모델은 각각 이용 약관이 있다. 개인용으로만 쓰고, 앱을 배포할 때는 모델의 재배포 허용 여부를 확인한다.
