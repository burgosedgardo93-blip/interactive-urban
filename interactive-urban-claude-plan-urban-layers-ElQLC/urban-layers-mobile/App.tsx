import { GLView } from "expo-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, StyleSheet, View } from "react-native";
import MapView, { MapPressEvent, Region } from "react-native-maps";
import * as THREE from "three";
import { ReactNativeAdapter } from "./src/adapters/ReactNativeAdapter";
// @ts-ignore Shared browser module reused directly.
import { resolveHeights } from "../buildingHeightResolver.js";
// @ts-ignore Shared browser module reused directly.
import { eraIndex, createMaterials } from "../material-factory.js";

type UrbanRecord = {
  id: string;
  title?: string;
  category: string;
  lat: number;
  lng: number;
  year: number;
  demolished: number | null;
  height_m?: number | null;
};

type SceneState = {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  meshesById: Map<string, THREE.Mesh>;
  bounds: Bounds;
};

type Bounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

const METERS_TO_WORLD_UNITS = 0.00157; // mirrored from browser overlay
const INITIAL_REGION: Region = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.16,
  longitudeDelta: 0.16,
};
const SF_BOUNDS: Bounds = {
  north: 37.812,
  south: 37.703,
  east: -122.356,
  west: -122.527,
};
const DEFAULT_FETCH_RANGE = { from: 1700, to: 2100 };

export default function App() {
  const adapterRef = useRef<ReactNativeAdapter | null>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const [region, setRegion] = useState<Region>(INITIAL_REGION);
  const [records, setRecords] = useState<UrbanRecord[]>([]);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });

  const mapInitialRegion = useMemo(() => INITIAL_REGION, []);

  const syncCameraToRegion = useCallback((nextRegion: Region) => {
    const sceneState = sceneRef.current;
    if (!sceneState) return;

    const bounds = regionToBounds(nextRegion);
    sceneState.bounds = bounds;

    const aspect = Math.max(viewport.width / Math.max(viewport.height, 1), 1);
    sceneState.camera.left = -aspect;
    sceneState.camera.right = aspect;
    sceneState.camera.top = 1;
    sceneState.camera.bottom = -1;
    sceneState.camera.position.set(0, -0.4, 0.915);
    sceneState.camera.lookAt(0, 0, 0);
    sceneState.camera.updateProjectionMatrix();

    for (const [id, mesh] of sceneState.meshesById.entries()) {
      const record = records.find((r) => r.id === id);
      if (!record) continue;
      const projected = projectToWorld(record, bounds, aspect);
      mesh.position.x = projected.x;
      mesh.position.y = projected.y;
    }
  }, [records, viewport.height, viewport.width]);

  const buildSceneMeshes = useCallback(async (sceneState: SceneState, recs: UrbanRecord[]) => {
    for (const mesh of sceneState.meshesById.values()) {
      sceneState.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    sceneState.meshesById.clear();

    const materialSet = createMaterials(THREE);
    let heights = new Map<string, number>();
    try {
      heights = await resolveHeights(recs);
    } catch (error) {
      console.warn("[UrbanLayersMobile] Height resolution failed:", error);
    }

    const aspect = Math.max(viewport.width / Math.max(viewport.height, 1), 1);
    for (const record of recs) {
      const era = eraIndex(record.year);
      const heightM = heights.get(record.id) ?? record.height_m ?? 10;
      const height = Math.max(heightM * METERS_TO_WORLD_UNITS, 0.015);
      const geometry = new THREE.BoxGeometry(0.03, 0.03, height);
      const mesh = new THREE.Mesh(geometry, materialSet[era].solid);
      const projected = projectToWorld(record, sceneState.bounds, aspect);
      mesh.position.set(projected.x, projected.y, height / 2);
      sceneState.scene.add(mesh);
      sceneState.meshesById.set(record.id, mesh);
    }
  }, [viewport.height, viewport.width]);

  const handleContextCreate = useCallback(async (gl: WebGLRenderingContext) => {
    const adapter = new ReactNativeAdapter(gl);
    adapterRef.current = adapter;
    await adapter.initialize();

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.OrthographicCamera(-adapter.aspect, adapter.aspect, 1, -1, -20, 20);
    camera.position.set(0, -0.4, 0.915);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffe8d0, 0.55));
    const keyLight = new THREE.DirectionalLight(0xffb266, 1.1);
    keyLight.position.set(-0.6, -0.8, 1.5);
    scene.add(keyLight);

    sceneRef.current = {
      scene,
      camera,
      meshesById: new Map<string, THREE.Mesh>(),
      bounds: regionToBounds(region),
    };

    if (records.length > 0) {
      await buildSceneMeshes(sceneRef.current, records);
      syncCameraToRegion(region);
    }

    adapter.start(() => {
      adapter.renderFrame(scene, camera);
    });
  }, [buildSceneMeshes, records, region, syncCameraToRegion]);

  const handleRegionChange = useCallback((nextRegion: Region) => {
    setRegion(nextRegion);
    syncCameraToRegion(nextRegion);
  }, [syncCameraToRegion]);

  const handleMapPress = useCallback((event: MapPressEvent) => {
    const sceneState = sceneRef.current;
    if (!sceneState) return;
    const hit = raycastFromMapPress(
      event.nativeEvent.coordinate.latitude,
      event.nativeEvent.coordinate.longitude,
      sceneState.bounds,
      sceneState.camera,
      Array.from(sceneState.meshesById.values()),
      viewport.width / Math.max(viewport.height, 1)
    );
    if (hit) {
      console.log("[UrbanLayersMobile] Building tapped:", hit.object.uuid);
    }
  }, [viewport.height, viewport.width]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.max(event.nativeEvent.layout.width, 1);
    const height = Math.max(event.nativeEvent.layout.height, 1);
    setViewport({ width, height });
    adapterRef.current?.resize(width, height);
    syncCameraToRegion(region);
  }, [region, syncCameraToRegion]);

  const fetchRecords = useCallback(async () => {
    try {
      const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
      if (env?.EXPO_PUBLIC_SUPABASE_URL && !env.SUPABASE_URL) env.SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
      if (env?.EXPO_PUBLIC_SUPABASE_ANON_KEY && !env.SUPABASE_ANON_KEY) env.SUPABASE_ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

      // @ts-ignore Shared browser module reused directly.
      const { fetchRecordsByBBox } = await import("../supabase-client.js");
      const fetched = await fetchRecordsByBBox(SF_BOUNDS, DEFAULT_FETCH_RANGE);
      setRecords(fetched as UrbanRecord[]);
    } catch (error) {
      console.warn("[UrbanLayersMobile] Supabase fetch failed:", error);
      setRecords([]);
    }
  }, []);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  useEffect(() => {
    if (!sceneRef.current || records.length === 0) return;
    buildSceneMeshes(sceneRef.current, records).then(() => {
      syncCameraToRegion(region);
    });
  }, [buildSceneMeshes, records, region, syncCameraToRegion]);

  useEffect(() => {
    return () => {
      if (sceneRef.current) {
        for (const mesh of sceneRef.current.meshesById.values()) {
          mesh.geometry.dispose();
        }
        sceneRef.current.meshesById.clear();
      }
      adapterRef.current?.dispose();
      adapterRef.current = null;
    };
  }, []);

  return (
    <View style={styles.container} onLayout={handleLayout}>
      <MapView
        style={StyleSheet.absoluteFillObject}
        initialRegion={mapInitialRegion}
        onRegionChange={handleRegionChange}
        onPress={handleMapPress}
      />
      <GLView
        style={styles.glOverlay}
        pointerEvents="none"
        onContextCreate={handleContextCreate}
      />
    </View>
  );
}

function regionToBounds(nextRegion: Region): Bounds {
  const halfLat = nextRegion.latitudeDelta / 2;
  const halfLng = nextRegion.longitudeDelta / 2;
  return {
    north: nextRegion.latitude + halfLat,
    south: nextRegion.latitude - halfLat,
    east: nextRegion.longitude + halfLng,
    west: nextRegion.longitude - halfLng,
  };
}

function projectToWorld(record: Pick<UrbanRecord, "lat" | "lng">, bounds: Bounds, aspect: number) {
  const xNorm = (record.lng - bounds.west) / Math.max(bounds.east - bounds.west, 1e-9);
  const yNorm = (record.lat - bounds.south) / Math.max(bounds.north - bounds.south, 1e-9);
  return {
    x: ((xNorm * 2) - 1) * aspect,
    y: -(((1 - yNorm) * 2) - 1),
  };
}

function raycastFromMapPress(
  lat: number,
  lng: number,
  bounds: Bounds,
  camera: THREE.Camera,
  meshes: THREE.Mesh[],
  aspect: number
) {
  if (meshes.length === 0) return null;
  const projected = projectToWorld({ lat, lng }, bounds, aspect);
  const ndc = new THREE.Vector2(projected.x / aspect, -projected.y);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(meshes);
  return hits[0] ?? null;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  glOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
});
