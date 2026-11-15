# 녹화 저장 검증 및 인계

| 작업 | 주로 수정할 파일 | 인계 조건 |
| --- | --- | --- |
| 방송 탐색과 녹화 상태 | `src/content/original_stream.ts`, `src/content/recording_controller.ts`, `src/content/recording_session.ts` | 원본 조회 성공·실패, 정지·취소, 검색 이동과 재시작을 확인한다. |
| 영역과 플레이어 UI | `src/content/region_selector.ts` | 영역 테두리와 플레이어 버튼이 영상 이동 및 녹화 상태를 따라가는지 확인한다. |
| 저장과 복구 | `src/background/service_worker.ts`, `src/shared/idb.ts` | 응답 누락과 저장 실패를 주입하고, 마지막으로 정상 기록한 구간과 새 녹화 상태를 확인한다. |
| 결과창·변환 | `src/result/`, `scripts/build.mjs` | 디스크 출력 장애와 결과창 종료를 주입한다. 기존 녹화의 바이트, 재시도, 임시 파일 해제와 다운로드를 확인한다. |
| 검증과 배포 준비 | `tests/browser/`, README 패치노트, [점검 기록](audit-0.4.0.md) | 같은 빌드를 검사하고 실패한 검사와 실제 방송에서 남은 검증을 기록한다. |

공유 파일이 필요한 경우 먼저 담당 에이전트에게 수정 범위를 전달한다. 검증 담당자는 실행하기 전에 빌드가 끝났는지 확인한다. 재현용 개인 방송 주소, 서명된 CDN 주소, 영상 파일은 저장소에 추가하지 않는다.

## 대용량 원본

64 MiB 이상은 브라우저 전용 임시 파일에 출력한다. 저장소 접근이 차단되면 전체 MP4를 메모리에 만들어 재시도하지 않는다. 결과창에서 재시도하거나 저장된 방송 조각을 `.fmp4`로 백업한다. 백업 파일에는 선택 시각 앞뒤의 조각 일부가 포함될 수 있다. 결과창을 닫으면 녹화 데이터에는 기존 10분 삭제 유예가 적용된다.

1. 같은 프로필에서 동일한 315MB 원본을 최소 3회 새 결과창으로 연다. 변환 전, 변환 중 최고, 결과창 표시 후, 창을 닫은 3초·30초 뒤의 전용 메모리를 기록한다. 전체와 GPU를 따로 기록한다.
2. 저장소 접근 실패, 디스크 기록 실패, 변환 도중 결과창 닫기를 각각 재현한다. 다음 열기에서 원본이 그대로 남고, 임시 작업 파일이 쌓이지 않으며, 재시도 결과가 재생되는지 확인한다.
3. 수정 전후 모두 파일의 재생 길이와 끝 부분을 확인한다. 워커가 0개인 결과와 프로세스 메모리 잔류를 별도로 적는다.

Edge에서 저장 실패와 결과창 종료를 재현하는 검사는 `npx playwright test tests/browser/split-start.spec.mjs -g 'large original survives'`다. 실행 전에 `CROPCLIP_TEST_BROWSER`를 `msedge`로 설정한다. 이 검사는 저장소 접근·마운트·변환 오류를 주입하고, 실제 디스크 여유 공간은 별도로 확인한다. 일부 바이트만 기록되는 경우는 `npm run check:unit`에서 검사한다.

대용량 일반 편집은 `npx playwright test tests/browser/split-start.spec.mjs -g 'large normal MP4|large WebM seek'`로 확인한다. 64 MiB 이상 녹화의 MP4·WebM 분할, 배속, 실시간 변환, 초반 정리, 탐색 정보 생성을 검사한다. 개별 다운로드할 분할 결과는 녹화의 삭제 유예까지 보관한다. 즉시 다운로드하는 편집 파일은 다운로드 완료를 확인한 뒤 삭제한다.

## 녹화 시작

`npx playwright test tests/browser/recording-startup.spec.mjs`는 실제 저장 파일과 짧은 녹화 보존을 검사한다. 방송 재생 프레임 간격도 측정하려면 녹화 프로파일로 1080p 샘플을 만든 뒤 `CROPCLIP_STARTUP_REPORT`에 JSON 저장 경로를 지정한다. 같은 소스에서 브라우저 실행을 나누고 `CROPCLIP_STARTUP_CAPTURE`에 `canvas` 또는 `vp8`을 지정하면 캡처 경로와 코덱을 각각 비교한다. 실제 MIME 형식, 첫 데이터 조각이 도착한 시각, 최대 프레임 간격이 끝난 시각을 함께 기록한다. 첫 조각을 받지 못한 실행은 통과로 보지 않는다.

일반 녹화 반복 측정은 기존 프로파일을 사용한다.

```powershell
npm run build
npm run check:unit
$env:CROPCLIP_TEST_BROWSER = 'msedge'
$env:CROPCLIP_PROFILE_FULL = '1'
$env:CROPCLIP_PROFILE_SECONDS = '33'
$env:CROPCLIP_PROFILE_CYCLES = '4'
$env:CROPCLIP_PROFILE_REPORT = "$env:TEMP/cropclip-recording-profile.json"
npx playwright test tests/browser/recording-profile.spec.mjs
```

인계에는 수정 파일, 테스트 명령·결과, 실패 재현과 남은 검증을 남긴다. 재현 환경 정보가 다음 수정에 꼭 필요한 경우에는 사용자에게 확인할 항목 하나를 구체적으로 묻는다.
