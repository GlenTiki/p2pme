import { createSurfaceMount } from "./surface.js";
import { demoSurface } from "./demo.js";

export { createSurfaceMount } from "./surface.js";

const demo = document.getElementById("local-demo");
const result = document.getElementById("local-demo-result");
if (demo && result) {
  createSurfaceMount(demo).mountSurface(
    "651f06dd-8e07-4c3e-acd4-1ac5db41b49a",
    demoSurface,
    (action) => {
      result.textContent = JSON.stringify(action, null, 2);
    },
  );
}
