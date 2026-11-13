using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;

// Minimal binary glTF 2.0 (GLB) writer for the Model Studio. Each part becomes
// one node + one mesh with its world transform baked into the vertices (so no
// quaternion handedness conversion is needed) and a metallic-roughness
// material. Unity is left-handed, glTF right-handed: X is mirrored and the
// triangle winding reversed, exactly the inverse of what glTFast does on import,
// so a model round-trips into the game looking the way it did in the studio.
public static class GlbWriter
{
    public struct Part
    {
        public string   Name;
        public Mesh     Mesh;
        public Matrix4x4 LocalToExport;   // part transform relative to the export origin
        public Color    BaseColor;        // alpha < 1 → BLEND
        public float    Metallic;
        public float    Roughness;
        public Color    Emissive;
    }

    public static byte[] Write(IList<Part> parts)
    {
        var bin = new MemoryStream();
        var bufferViews = new List<string>();
        var accessors   = new List<string>();
        var meshes      = new List<string>();
        var nodes       = new List<string>();
        var materials   = new List<string>();
        var nodeIdx     = new List<string>();
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        string F(float f) => f.ToString("R", inv);

        for (int p = 0; p < parts.Count; p++)
        {
            var part = parts[p];
            var src  = part.Mesh;
            var verts = src.vertices;
            var norms = src.normals;
            var tris  = src.triangles;
            if (verts.Length == 0 || tris.Length == 0) continue;

            var m  = part.LocalToExport;
            var nm = m.inverse.transpose;
            var pos = new Vector3[verts.Length];
            var nor = new Vector3[verts.Length];
            Vector3 min = new(float.MaxValue, float.MaxValue, float.MaxValue);
            Vector3 max = new(float.MinValue, float.MinValue, float.MinValue);
            for (int i = 0; i < verts.Length; i++)
            {
                var w = m.MultiplyPoint3x4(verts[i]);
                w.x = -w.x;
                pos[i] = w;
                min = Vector3.Min(min, w); max = Vector3.Max(max, w);
                var n = norms.Length == verts.Length ? nm.MultiplyVector(norms[i]).normalized : Vector3.up;
                n.x = -n.x;
                nor[i] = n;
            }

            int posView = AddView(bin, bufferViews, WriteVec3(pos), 34962);
            int norView = AddView(bin, bufferViews, WriteVec3(nor), 34962);
            // Reverse winding for the mirrored X axis.
            var idx = new byte[tris.Length * 4];
            for (int t = 0; t < tris.Length; t += 3)
            {
                Buffer.BlockCopy(BitConverter.GetBytes((uint)tris[t]),     0, idx, (t + 0) * 4, 4);
                Buffer.BlockCopy(BitConverter.GetBytes((uint)tris[t + 2]), 0, idx, (t + 1) * 4, 4);
                Buffer.BlockCopy(BitConverter.GetBytes((uint)tris[t + 1]), 0, idx, (t + 2) * 4, 4);
            }
            int idxView = AddView(bin, bufferViews, idx, 34963);

            int posAcc = accessors.Count;
            accessors.Add($"{{\"bufferView\":{posView},\"componentType\":5126,\"count\":{pos.Length},\"type\":\"VEC3\"," +
                          $"\"min\":[{F(min.x)},{F(min.y)},{F(min.z)}],\"max\":[{F(max.x)},{F(max.y)},{F(max.z)}]}}");
            int norAcc = accessors.Count;
            accessors.Add($"{{\"bufferView\":{norView},\"componentType\":5126,\"count\":{nor.Length},\"type\":\"VEC3\"}}");
            int idxAcc = accessors.Count;
            accessors.Add($"{{\"bufferView\":{idxView},\"componentType\":5125,\"count\":{tris.Length},\"type\":\"SCALAR\"}}");

            var c = part.BaseColor.linear;
            var e = part.Emissive.linear;
            bool blend = part.BaseColor.a < 0.999f;
            int matIdx = materials.Count;
            materials.Add("{" +
                $"\"name\":\"{Esc(part.Name)}\"," +
                $"\"pbrMetallicRoughness\":{{\"baseColorFactor\":[{F(c.r)},{F(c.g)},{F(c.b)},{F(part.BaseColor.a)}]," +
                $"\"metallicFactor\":{F(Mathf.Clamp01(part.Metallic))},\"roughnessFactor\":{F(Mathf.Clamp01(part.Roughness))}}}" +
                (e.maxColorComponent > 0.001f ? $",\"emissiveFactor\":[{F(Mathf.Clamp01(e.r))},{F(Mathf.Clamp01(e.g))},{F(Mathf.Clamp01(e.b))}]" : "") +
                (blend ? ",\"alphaMode\":\"BLEND\"" : "") +
                "}");

            int meshIdx = meshes.Count;
            meshes.Add($"{{\"name\":\"{Esc(part.Name)}\",\"primitives\":[{{\"attributes\":{{\"POSITION\":{posAcc},\"NORMAL\":{norAcc}}},\"indices\":{idxAcc},\"material\":{matIdx}}}]}}");
            nodeIdx.Add(nodes.Count.ToString());
            nodes.Add($"{{\"name\":\"{Esc(part.Name)}\",\"mesh\":{meshIdx}}}");
        }

        var json = "{" +
            "\"asset\":{\"version\":\"2.0\",\"generator\":\"Pludo Model Studio\"}," +
            "\"scene\":0," +
            $"\"scenes\":[{{\"nodes\":[{string.Join(",", nodeIdx)}]}}]," +
            $"\"nodes\":[{string.Join(",", nodes)}]," +
            $"\"meshes\":[{string.Join(",", meshes)}]," +
            $"\"materials\":[{string.Join(",", materials)}]," +
            $"\"accessors\":[{string.Join(",", accessors)}]," +
            $"\"bufferViews\":[{string.Join(",", bufferViews)}]," +
            $"\"buffers\":[{{\"byteLength\":{bin.Length}}}]" +
            "}";

        var jsonBytes = Encoding.UTF8.GetBytes(json);
        int jsonPad = (4 - jsonBytes.Length % 4) % 4;
        int binPad  = (4 - (int)bin.Length % 4) % 4;
        int jsonLen = jsonBytes.Length + jsonPad;
        int binLen  = (int)bin.Length + binPad;

        var outStream = new MemoryStream();
        var w2 = new BinaryWriter(outStream);
        w2.Write(0x46546C67u);                 // "glTF"
        w2.Write(2u);
        w2.Write((uint)(12 + 8 + jsonLen + 8 + binLen));
        w2.Write((uint)jsonLen); w2.Write(0x4E4F534Au); // "JSON"
        w2.Write(jsonBytes); for (int i = 0; i < jsonPad; i++) w2.Write((byte)0x20);
        w2.Write((uint)binLen);  w2.Write(0x004E4942u); // "BIN\0"
        w2.Write(bin.ToArray()); for (int i = 0; i < binPad; i++) w2.Write((byte)0);
        w2.Flush();
        return outStream.ToArray();
    }

    private static int AddView(MemoryStream bin, List<string> views, byte[] data, int target)
    {
        while (bin.Length % 4 != 0) bin.WriteByte(0);
        long offset = bin.Length;
        bin.Write(data, 0, data.Length);
        views.Add($"{{\"buffer\":0,\"byteOffset\":{offset},\"byteLength\":{data.Length},\"target\":{target}}}");
        return views.Count - 1;
    }

    private static byte[] WriteVec3(Vector3[] v)
    {
        var b = new byte[v.Length * 12];
        for (int i = 0; i < v.Length; i++)
        {
            Buffer.BlockCopy(BitConverter.GetBytes(v[i].x), 0, b, i * 12,     4);
            Buffer.BlockCopy(BitConverter.GetBytes(v[i].y), 0, b, i * 12 + 4, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(v[i].z), 0, b, i * 12 + 8, 4);
        }
        return b;
    }

    private static string Esc(string s) => (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
}
