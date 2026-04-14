import { GLView } from "expo-gl";
import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import * as THREE from "three";
import { ReactNativeAdapter } from "./src/adapters/ReactNativeAdapter";
// @ts-ignore Shared browser module reused directly.
import { resolveHeights } from "../buildingHeightResolver.js";
// @ts-ignore Shared browser module reused directly.
import { eraIndex, createMaterials } from "../material-factory.js";
// @ts-ignore Shared browser module intentionally reused unchanged.
import { ThreeOverlay } from "../three-overlay.js";

const FERRY_BUILDING_RECORD = {
  id: "sf-001",
  name: "Ferry Building",
  lat: 37.7955,
  lng: -122.3937,
  year: 1898,
  category: "civic",
  demolished: null,
};

const METERS_TO_WORLD_UNITS = 0.00157;

export default function App() {
  const adapterRef = useRef<ReactNativeAdapter | null>(null);

  const handleContextCreate = useCallback(async (gl: WebGLRenderingContext) => {
    const adapter = new ReactNativeAdapter(gl);
    adapterRef.current = adapter;
    await adapter.initialize();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);

    const camera = new THREE.PerspectiveCamera(55, adapter.aspect, 0.1, 100);
    camera.position.set(0, 0.75, 2.4);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xfff4dc, 0.45));
    const keyLight = new THREE.DirectionalLight(0xffd7a3, 1.2);
    keyLight.position.set(1.3, 1.1, 2.0);
    scene.add(keyLight);

    let resolvedHeightM = 20;
    try {
      const heights = await resolveHeights([FERRY_BUILDING_RECORD]);
      resolvedHeightM = heights.get(FERRY_BUILDING_RECORD.id) ?? resolvedHeightM;
    } catch {
      resolvedHeightM = 20;
    }

    const materials = createMaterials(THREE);
    const era = eraIndex(FERRY_BUILDING_RECORD.year);
    const height = Math.max(resolvedHeightM * METERS_TO_WORLD_UNITS, 0.08);
    const footprint = 0.3;
    const geometry = new THREE.BoxGeometry(footprint, footprint, height);
    const building = new THREE.Mesh(geometry, materials[era].solid);
    building.position.set(0, 0, height / 2);
    scene.add(building);

    // Keep reference to browser overlay module to ensure unchanged module inclusion.
    void ThreeOverlay;

    adapter.start(() => {
      building.rotation.z += 0.0035;
      adapter.renderFrame(scene, camera);
    });
  }, []);

  useEffect(() => {
    return () => {
      adapterRef.current?.dispose();
      adapterRef.current = null;
    };
  }, []);

  return (
    <View style={styles.container}>
      <GLView style={styles.glView} onContextCreate={handleContextCreate} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  glView: { flex: 1 },
});
