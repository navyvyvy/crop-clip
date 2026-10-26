# 방송 재생이 녹화 시작 시 끊기는 현상 (2026-10-27)

상태: 합성 영상의 Chromium·Edge 검사에서 시작 끊김 완화를 확인했다. 사용자가 선택한 빠른 MP4 변환을 유지하도록 기존 H.264 코덱과 비트레이트는 유지했다. 실제 방송 장시간 검증과 브라우저·드라이버 환경별 확인은 남아 있다.

## 관찰

새 브라우저에서 이미 생성한 1920×1080/30fps 영상 파일을 재생하고, 녹화를 시작하기 전후의 requestVideoFrameCallback 간격을 측정했다. 측정 브라우저에서 테스트 영상을 먼저 인코딩하지 않도록 해 첫 인코더 초기화 비용이 가려지지 않게 했다.

- 기존 H.264: 첫 시작의 프레임 공백 350ms, 후속 시작 420ms/360ms. 녹화 전에는 최대 약 40~50ms였다.
- VP8 비교: Chromium 첫 시작 140ms, Edge 130ms. 후속 측정도 각각 80~160ms, 50~120ms였다. WebM의 VP8 전환은 빠른 MP4 변환을 유지하지 못하므로 채택하지 않았다.
- H.264 유지 비교의 첫 시작 공백: 소프트웨어 캔버스 320ms, 원본 캡처/오디오를 제외한 진단 240ms, WebCodecs 예열 370ms, 작은 MediaRecorder 예열 340ms, 영상 프레임에 맞춘 그리기 210ms, 명시적 H.264 프로필 290ms, 프로필+프레임 동기화 260ms. 모두 첫 시작 200ms 미만 기준을 통과하지 못했다.
- MediaRecorder.start()의 동기 호출 자체는 대부분 1ms 이내였지만 실제 start 이벤트는 약 300~400ms 뒤에 도착했다. 코덱 변경 비교를 함께 보면 H.264 녹화 파이프라인 시작과 관련된 경합이 유력하다. GPU/드라이버의 구체적인 내부 원인을 확정한 것은 아니다.

위 수치는 서로 다른 브라우저 실행의 관찰값이며 통계적으로 보장하는 개선율이 아니다. 합성 파일은 반복 재생되므로 실제 라이브 방송의 스트림·디코더·드라이버 환경과도 차이가 있다. 프레임 동기화만 사용하는 방식은 배경 탭 동작도 별도로 검증해야 한다.

## 적용한 변경과 최종 측정

src/content/frame_capture.ts에서 영상의 VideoFrame을 먼저 받은 뒤, 필요한 영역은 VideoFrame 복제로 지정해 생성 트랙에 전달한다. HTML 영상에서 프레임을 생성할 때 영역·크기를 한꺼번에 지정한 중간 구현은 Chromium에서 300~450ms 공백이 다시 나와 제외했다.

| 브라우저·모드 | 첫 시작 최대 공백 | 후속 시작 최대 공백 |
| --- | --- | --- |
| Chromium 전체 | 160ms | 120ms / 100ms |
| Chromium 영역 | 120ms | 120ms / 100ms |
| Edge 전체 | 120ms | 120ms / 110ms |
| Edge 영역 | 160ms | 120ms / 130ms |

- H.264 코덱·비트레이트와 기존 녹화 형식 선택은 유지했다. WebM에서 MP4로 변환할 때 실시간 MediaRecorder 재인코딩이 발생하지 않고 결과가 재생되는지 검사했다.
- 영상의 네 구역에 서로 다른 색을 넣어, 전체 녹화와 선택 영역의 실제 픽셀 및 출력 크기가 맞는지 검사했다. 저장된 음성과 마지막 구간 탐색, 전체·선택 구간의 2·3·4분할 검사도 통과했다.
- 대기 중인 프레임은 한 개로 제한한다. 종료·취소 시 프레임, 생성 트랙, 스트림 writer를 해제하고, 프레임 전달 오류는 기존 녹화 오류 복구 경로로 보낸다.
- 다중 영역과 미지원 브라우저는 기존 캔버스 경로를 사용한다. 픽셀 정렬이나 레터박스 때문에 직접 프레임 전달이 불가능한 경우도 정확한 구도를 유지하도록 캔버스로 그린다. 따라서 모든 구도·브라우저에서 같은 개선 폭을 보장하지 않는다.
- 최종 변경의 전체 단위 검사가 통과했다. 브라우저 전체 검사 8개를 통과한 뒤 프레임 복제 방식 보완에 해당하는 녹화·영역·음성·분할·복구 검사를 재실행했다. Chromium과 Edge 모두 출력 크기·색상·음성 및 실시간 재인코딩 없는 MP4 변환 검사를 통과했다.
- Chromium 전체·영역 녹화 종료 24회: 회차별 GC 후 열린 프레임·생성 트랙·인코더·캔버스·변환 워커 잔존 수 0. 워밍업 이후 JS 힙 증가는 254,704바이트였다. 브라우저 전체 프로세스의 private memory는 약 702~831MiB 범위로 증가·감소하다 마지막에 748MiB였으며, 반복 횟수에 비례하는 지속 증가는 관찰되지 않았다.
- Edge 시작·취소 16회: 4회 단위 검사에서 위 자원 잔존 수 모두 0, 최종 IndexedDB recordings/parts/chunks 모두 0개였다. 프로세스 private memory는 약 567~578MiB였다. 두 반복 검사에서 재사용하는 비활성 원본 오디오 트랙 1개는 의도적으로 유지됐다.

VideoFrame의 영역 복제는 [WebCodecs 명세](https://www.w3.org/TR/webcodecs/#videoframe-interface)에 따른다. 생성 트랙 API는 [Chrome의 insertable streams 문서](https://developer.chrome.com/docs/capabilities/web-apis/mediastreamtrack-insertable-media-processing)에 설명되어 있으며, 기능 검출과 기존 경로를 함께 유지했다.

## 재현

먼저 기존 recording-profile.spec.mjs를 실행해 테스트 영상 캐시를 생성한다. 이후 새 브라우저로 진단 검사를 실행한다.

```powershell
$env:CROPCLIP_PROFILE_REPORT = 'node_modules/.cache/startup-source-profile.json'
npx playwright test recording-profile.spec.mjs
Remove-Item Env:CROPCLIP_PROFILE_REPORT
$env:CROPCLIP_STARTUP_REPORT = 'node_modules/.cache/startup-report.json'
npx playwright test recording-startup.spec.mjs
```

이 진단은 명시적으로 실행할 때 첫 시작의 200ms 이상 공백을 실패로 보고한다. 일반 브라우저 검사에서는 건너뛴다. 실패 기준을 완화해 해결된 것처럼 처리하지 않았다.

비교 실험 원본은 Git에서 제외된 node_modules/.cache/cropclip-startup-*.json에 있다. 임시 코덱 변경, 예열, 캔버스와 타이머 교체 코드는 제거했다.

최종 시작 측정은 cropclip-startup-clone-*.json, 24회 녹화/16회 취소 결과는 cropclip-native-frame-profile-24-chromium.json 및 cropclip-native-frame-cancel-final-edge.json에 있다. 이 검사는 OS/GPU 누수 부재나 실제 방송의 모든 부하 조건을 보장하지 않는다.
