// Procedural plane mesh used for sculpted terrain. Built once per terrain
// entity with N segments per side (N = TERRAIN_GRID_SIZE on the server, 64).
// GameRenderClient calls Create(N), then ApplyHeights(go, heights) on every
// diff that carries a new height grid — vertices' Y is rewritten, normals
// recomputed, and the MeshCollider is rebuilt from the live mesh so the
// existing groundY raycast / SnapEntityYToGround paths Just Work.
//
// The mesh is unit-sized (XZ from -0.5 to 0.5). The terrain GameObject's
// localScale is set by the server to (sizeX, 1, sizeZ), which matches the
// pre-existing CreatePrimitive(Plane) sizing pipeline. So the only thing
// that changes vs. the old flat Plane primitive is segment count and the
// per-frame vertex deformation.

using System.Collections.Generic;
using UnityEngine;

public static class PludoTerrainMesh
{
    // Build a unit-sized N-by-N segmented plane GameObject with MeshFilter,
    // MeshRenderer, and a MeshCollider attached. Heights start at 0 so it
    // looks like the old flat plane until ApplyHeights is called.
    public static GameObject Create(int segments)
    {
        if (segments < 2) segments = 2;
        var go = new GameObject("PludoTerrain");

        var mesh = new Mesh { name = "PludoTerrainMesh" };
        mesh.indexFormat = segments > 127
            ? UnityEngine.Rendering.IndexFormat.UInt32
            : UnityEngine.Rendering.IndexFormat.UInt16;

        int N = segments;
        var verts   = new Vector3[N * N];
        var uvs     = new Vector2[N * N];
        var normals = new Vector3[N * N];
        for (int j = 0; j < N; j++)
        {
            for (int i = 0; i < N; i++)
            {
                float u = (float)i / (N - 1);
                float v = (float)j / (N - 1);
                int idx = j * N + i;
                verts[idx]   = new Vector3(u - 0.5f, 0f, v - 0.5f);
                uvs[idx]     = new Vector2(u, v);
                normals[idx] = Vector3.up;
            }
        }
        var tris = new int[(N - 1) * (N - 1) * 6];
        int t = 0;
        for (int j = 0; j < N - 1; j++)
        {
            for (int i = 0; i < N - 1; i++)
            {
                int i00 = j * N + i;
                int i10 = j * N + (i + 1);
                int i01 = (j + 1) * N + i;
                int i11 = (j + 1) * N + (i + 1);
                tris[t++] = i00; tris[t++] = i01; tris[t++] = i11;
                tris[t++] = i00; tris[t++] = i11; tris[t++] = i10;
            }
        }
        mesh.vertices  = verts;
        mesh.uv        = uvs;
        mesh.normals   = normals;
        mesh.triangles = tris;
        mesh.RecalculateBounds();

        var mf = go.AddComponent<MeshFilter>();
        mf.sharedMesh = mesh;
        var mr = go.AddComponent<MeshRenderer>();
        // Default material — GameRenderClient overrides this with the
        // Pludo/Terrain shader material the moment terrainLayers arrives.
        var defaultShader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        mr.material = new Material(defaultShader);
        var mc = go.AddComponent<MeshCollider>();
        mc.sharedMesh = mesh;
        return go;
    }

    // Re-deform an existing terrain GameObject's mesh from a flat row-major
    // height array of length N*N (N = segments). Recomputes normals so the
    // PBR shader's slope-based layer blend reflects the new shape, and
    // pushes the deformed mesh back into the MeshCollider so the player's
    // groundY raycast follows the contour.
    public static void ApplyHeights(GameObject go, IList<float> heights, int segments)
    {
        if (go == null) return;
        var mf = go.GetComponent<MeshFilter>();
        if (mf == null || mf.sharedMesh == null) return;
        int N = segments;
        if (heights == null || heights.Count < N * N) return;

        var mesh = mf.sharedMesh;
        var verts = mesh.vertices;
        if (verts.Length != N * N) return;

        for (int j = 0; j < N; j++)
        {
            for (int i = 0; i < N; i++)
            {
                int idx = j * N + i;
                verts[idx].y = heights[idx];
            }
        }
        mesh.vertices = verts;
        mesh.RecalculateNormals();
        mesh.RecalculateBounds();

        var mc = go.GetComponent<MeshCollider>();
        if (mc != null)
        {
            // Re-assigning the mesh forces MeshCollider to rebuild its BVH.
            mc.sharedMesh = null;
            mc.sharedMesh = mesh;
        }
    }
}
