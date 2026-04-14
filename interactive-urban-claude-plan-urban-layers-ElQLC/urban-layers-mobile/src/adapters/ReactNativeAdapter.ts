import type { ExpoWebGLRenderingContext } from "expo-gl";
import { Renderer } from "expo-three";
import * as THREE from "three";

type RenderCallback = () => void;

export class ReactNativeAdapter {
  private readonly gl: ExpoWebGLRenderingContext;
  private readonly renderer: Renderer;
  private frameHandle: number | null = null;
  private running = false;
  private width: number;
  private height: number;

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl as ExpoWebGLRenderingContext;
    this.width = this.gl.drawingBufferWidth;
    this.height = this.gl.drawingBufferHeight;
    this.renderer = new Renderer({ gl: this.gl, antialias: true, alpha: true });
  }

  async initialize(): Promise<void> {
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height);
  }

  get aspect(): number {
    return this.width / this.height;
  }

  getThreeContext(): ExpoWebGLRenderingContext {
    return this.gl;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height);
  }

  start(renderCallback: RenderCallback): void {
    if (this.running) return;
    this.running = true;

    const loop = () => {
      if (!this.running) return;
      try {
        renderCallback();
      } catch (error) {
        // Keep the render loop alive and surface the failure for debugging.
        console.error("[ReactNativeAdapter] Render loop callback failed:", error);
      } finally {
        if (this.running) {
          this.frameHandle = requestAnimationFrame(loop);
        }
      }
    };

    this.frameHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  renderFrame(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
    this.gl.endFrameEXP();
  }

  dispose(): void {
    this.stop();
    this.renderer.dispose();
  }
}
