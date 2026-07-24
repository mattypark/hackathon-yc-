// T+30 gate. Proves the Linq key + video pre-upload flow end to end:
//   node test-send.js +1YOURNUMBER            (text only)
//   node test-send.js +1YOURNUMBER sample.mp4 (text + video — use a >10MB file
//                                              so the pre-upload path is proven)
import "dotenv/config";
import { sendText, sendVideo } from "./linq.js";

const [to, videoPath] = process.argv.slice(2);
if (!to) {
  console.error("usage: node test-send.js +1YOURNUMBER [video.mp4]");
  process.exit(1);
}

const result = videoPath
  ? await sendVideo(to, videoPath, "jptr test cut 🎬")
  : await sendText(to, "jptr alive ✅");

console.log("sent:", result);
