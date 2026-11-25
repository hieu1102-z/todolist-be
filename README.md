# TodoList BE

Backend Node.js 22 cho Android TodoList. API xác minh Firebase ID token và dùng Firestore (default) trong Firebase project do nhóm cấu hình. Dữ liệu đang dùng ở asia-east1 giữ nguyên.

## Chạy kiểm thử độc lập

Mở terminal ở gốc repo BE. Cần Node.js 22 và Java để chạy Firebase Emulator Suite.

~~~powershell
npm.cmd ci
npm.cmd run test:emulator
~~~

Lệnh dùng project giả lập demo-todolist và chạy Auth, Firestore, HTTP API, Security Rules và tiến trình dọn dữ liệu. Không cần checkout App hoặc cấp khóa Firebase thật để chạy các bài kiểm thử.

## Triển khai Render

Kết nối repo GitHub BE với Render, rồi tạo Web Service bằng các thiết lập sau.

| Mục | Giá trị |
| --- | --- |
| Runtime | Node |
| Region | Singapore |
| Instance Type | Free |
| Root Directory | Để trống, package.json nằm ở gốc repo |
| Build Command | npm ci --omit=dev |
| Start Command | npm start |
| Health Check Path | /healthz |
| NODE_VERSION | 22.x |
| NODE_ENV | production |
| FIREBASE_PROJECT_ID | Cùng project với google-services.json của Android |
| GOOGLE_APPLICATION_CREDENTIALS | /etc/secrets/firebase-service-account.json |

Trong mục Environment của Render, thêm khóa của service account riêng dưới dạng Secret File tên firebase-service-account.json. Service account cần quyền đọc/ghi tài liệu Firestore và đọc tài khoản Firebase Auth. Cấu hình mẫu nằm trong .env.example. Máy chủ đọc các biến môi trường, nên nếu chạy cục bộ hãy đặt chúng trong shell trước khi gọi npm start.

Sau khi deploy, gọi GET /healthz trên URL HTTPS của Render để xác nhận tiến trình đã chạy. Sau đó truyền chính URL gốc đó cho Gradle property WORKSPACE_API_BASE_URL bên repo App. Render Free có thể ngủ khi không có yêu cầu. Tác vụ dọn tiếp tục từ Firestore khi máy chủ thức.

## Triển khai Firestore Rules và indexes

Chạy từ repo BE. Chọn Project ID thật trùng với Android và Render. Firestore (default) ở asia-east1 được dùng lại.

~~~powershell
$firebase = '.\node_modules\.bin\firebase.cmd'
$projectId = 'your-project-id'
& $firebase login
& $firebase firestore:databases:list --project $projectId
& $firebase deploy --only firestore --project $projectId
~~~

Lệnh deploy đưa Rules và indexes từ repo BE lên project đã chọn. Node.js thay thế hai Cloud Functions cũ; nếu chúng đang phục vụ APK cũ, chỉ gỡ sau khi APK mới đồng bộ qua Render và các yêu cầu dọn đang chờ đã hoàn tất.

## Hợp đồng HTTP

- GET /healthz trả trạng thái tiến trình. Header `X-Workspace-Features` liệt kê `default-category-v1`, `category-icon-v1` và `sync-metadata-v1`.
- Gửi `include_sync_metadata: true` trong lệnh `LIST` để lấy thêm `server_seq` của từng danh mục. APK có thể dùng mốc này để bỏ qua snapshot đã tải.
- Trong Render Logs, đối chiếu `workspace_request` và `cleanup_receipt_committed` qua `operation_id`. Dùng `category_hash` cùng `server_seq` để đối chiếu lượt tải ở Android. `auth_ms` đo xác minh Firebase Auth và `firestore_ms` đo phần xử lý nghiệp vụ có truy cập Firestore.
- Lệnh `ENSURE_DEFAULT_CATEGORY` tạo danh mục ẩn riêng của UID xác thực. `LIST` chỉ trả danh mục đó khi client gửi `include_default: true`. Các danh mục thường tên `to do` vẫn hoạt động như trước.
- POST /v1/workspace nhận JSON theo cấu trúc lệnh workspace, với Firebase ID token trong Authorization: Bearer <id-token>.
- HTTP 200 trả result cho thao tác xác nhận. HTTP 202 trả result.pending=true khi Firestore đã ghi công việc dọn và chờ hoàn thành. Gửi lại đúng operation_id và cùng nội dung để lấy kết quả.
- Phản hồi lỗi có business_code. API kiểm tra UID xác thực, quyền thành viên và quyền OWNER cho xóa vĩnh viễn.
