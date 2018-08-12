
import { mat4, mat2d } from 'gl-matrix';

import { BMD, BMT, HierarchyNode, HierarchyType, MaterialEntry, Shape, ShapeDisplayFlags, TEX1_Sampler, TEX1_TextureData, DRW1JointKind, TTK1Animator, ANK1Animator, bindANK1Animator, TEX1 } from './j3d';
import { TTK1, bindTTK1Animator, TRK1, bindTRK1Animator, TRK1Animator, ANK1 } from './j3d';

import * as GX_Material from '../gx/gx_material';
import { MaterialParams, SceneParams, GXRenderHelper, PacketParams, GXShapeHelper, loadedDataCoalescer, fillSceneParamsFromRenderState, translateTexFilter, translateWrapMode, GXTextureHolder } from '../gx/gx_render';

import { RenderFlags, RenderState } from '../render';
import { computeViewMatrix, computeModelMatrixBillboard, computeModelMatrixYBillboard, computeViewMatrixSkybox, texEnvMtx, AABB, IntersectionState } from '../Camera';
import BufferCoalescer, { CoalescedBuffers } from '../BufferCoalescer';
import { TextureMapping } from '../TextureHolder';
import AnimationController from '../AnimationController';
import { nArray } from '../util';

export class J3DTextureHolder extends GXTextureHolder<TEX1_TextureData> {
    public addJ3DTextures(gl: WebGL2RenderingContext, bmd: BMD, bmt: BMT = null) {
        this.addTextures(gl, bmd.tex1.textureDatas);
        if (bmt)
            this.addTextures(gl, bmt.tex1.textureDatas);
    }
}

function texProjPerspMtx(dst: mat4, fov: number, aspect: number, scaleS: number, scaleT: number, transS: number, transT: number): void {
    const cot = 1 / Math.tan(fov / 2);

    dst[0] = (cot / aspect) * scaleS;
    dst[4] = 0.0;
    dst[8] = -transS;
    dst[12] = 0.0;

    dst[1] = 0.0;
    dst[5] = cot * scaleT;
    dst[9] = -transT;
    dst[13] = 0.0;

    dst[2] = 0.0;
    dst[6] = 0.0;
    dst[10] = -1.0;
    dst[14] = 0.0;

    // Fill with junk to try and signal when something has gone horribly wrong. This should go unused,
    // since this is supposed to generate a mat4x3 matrix.
    dst[3] = 9999.0;
    dst[7] = 9999.0;
    dst[11] = 9999.0;
    dst[15] = 9999.0;
}

class ShapeInstanceState {
    public modelMatrix: mat4 = mat4.create();
    public matrixArray: mat4[] = [];
    public matrixVisibility: IntersectionState[] = [];
    public isSkybox: boolean;
}

// TODO(jstpierre): Rename the Command_* classes. Is it even worth having the Command_* vs. Instance split anymore?

const scratchModelMatrix = mat4.create();
const scratchViewMatrix = mat4.create();
const posMtxVisibility: IntersectionState[] = nArray(10, () => IntersectionState.FULLY_INSIDE);
class Command_Shape {
    private packetParams = new PacketParams();
    private shapeHelpers: GXShapeHelper[] = [];

    constructor(gl: WebGL2RenderingContext, private shape: Shape, coalescedBuffers: CoalescedBuffers[]) {
        this.shapeHelpers = shape.packets.map((packet) => {
            return new GXShapeHelper(gl, coalescedBuffers.shift(), this.shape.loadedVertexLayout, packet.loadedVertexData);
        })
    }

    public draw(state: RenderState, renderHelper: GXRenderHelper, shapeInstanceState: ShapeInstanceState): void {
        const modelView = this.computeModelView(state, shapeInstanceState);

        let needsUpload = false;

        for (let p = 0; p < this.shape.packets.length; p++) {
            const packet = this.shape.packets[p];

            // Update our matrix table.
            for (let i = 0; i < packet.matrixTable.length; i++) {
                const matrixIndex = packet.matrixTable[i];

                // Leave existing matrix.
                if (matrixIndex === 0xFFFF)
                    continue;

                const posMtx = shapeInstanceState.matrixArray[matrixIndex];
                posMtxVisibility[i] = shapeInstanceState.matrixVisibility[matrixIndex];
                mat4.mul(this.packetParams.u_PosMtx[i], modelView, posMtx);
                needsUpload = true;
            }

            // If all matrices are invisible, we can cull.
            let frustumCull = true;
            for (let i = 0; i < posMtxVisibility.length; i++) {
                if (posMtxVisibility[i] !== IntersectionState.FULLY_OUTSIDE) {
                    frustumCull = false;
                    break;
                }
            }

            if (frustumCull)
                return;

            if (needsUpload) {
                renderHelper.bindPacketParams(state, this.packetParams);
                needsUpload = false;
            }

            const shapeHelper = this.shapeHelpers[p];
            shapeHelper.drawSimple(state);
        }

        state.renderStatisticsTracker.drawCallCount++;
    }

    public destroy(gl: WebGL2RenderingContext) {
        this.shapeHelpers.forEach((shapeHelper) => shapeHelper.destroy(gl));
    }

    private computeModelView(state: RenderState, shapeInstanceState: ShapeInstanceState): mat4 {
        switch (this.shape.displayFlags) {
        case ShapeDisplayFlags.USE_PNMTXIDX:
        case ShapeDisplayFlags.NORMAL:
            // We always use PNMTXIDX in the normal case -- and we hardcode missing attributes to 0.
            mat4.copy(scratchModelMatrix, shapeInstanceState.modelMatrix);
            break;

        case ShapeDisplayFlags.BILLBOARD:
            computeModelMatrixBillboard(scratchModelMatrix, state.camera);
            mat4.mul(scratchModelMatrix, shapeInstanceState.modelMatrix, scratchModelMatrix);
            break;
        case ShapeDisplayFlags.Y_BILLBOARD:
            computeModelMatrixYBillboard(scratchModelMatrix, state.camera);
            mat4.mul(scratchModelMatrix, shapeInstanceState.modelMatrix, scratchModelMatrix);
            break;
        default:
            throw new Error("whoops");
        }

        if (shapeInstanceState.isSkybox) {
            computeViewMatrixSkybox(scratchViewMatrix, state.camera);
        } else {
            computeViewMatrix(scratchViewMatrix, state.camera);
        }

        mat4.mul(scratchViewMatrix, scratchViewMatrix, scratchModelMatrix);
        return scratchViewMatrix;
    }
}

export class MaterialInstanceState {
    public texMatrices: mat4[] = nArray(8, () => mat4.create());
    public colors: GX_Material.Color[] = nArray(ColorOverride.COUNT, () => new GX_Material.Color());
}

export class Command_Material {
    private static matrixScratch = mat4.create();
    private static materialParams = new MaterialParams();

    public name: string;

    private renderFlags: RenderFlags;
    public program: GX_Material.GX_Program;

    constructor(private bmdModel: BMDModel, public material: MaterialEntry, hacks?: GX_Material.GXMaterialHacks) {
        this.name = material.name;
        this.program = new GX_Material.GX_Program(material.gxMaterial, hacks);
        this.program.name = this.name;
        this.renderFlags = GX_Material.translateRenderFlags(this.material.gxMaterial);
    }

    public bindMaterial(state: RenderState, renderHelper: GXRenderHelper, textureHolder: J3DTextureHolder, materialInstanceState: MaterialInstanceState): void {
        state.useProgram(this.program);
        state.useFlags(this.renderFlags);

        const materialParams = Command_Material.materialParams;
        this.fillMaterialParams(materialParams, state, textureHolder, materialInstanceState);
        renderHelper.bindMaterialParams(state, materialParams);
        renderHelper.bindMaterialTextures(state, materialParams, this.program);
    }

    public destroy(gl: WebGL2RenderingContext) {
        this.program.destroy(gl);
    }

    private fillMaterialParams(materialParams: MaterialParams, state: RenderState, textureHolder: J3DTextureHolder, materialInstanceState: MaterialInstanceState): void {
        // Bind color parameters.
        // TODO(jstpierre): Replace separate buffers with one large array in gx_render?
        materialParams.u_ColorMatReg[0].copy(materialInstanceState.colors[ColorOverride.MAT0]);
        materialParams.u_ColorMatReg[1].copy(materialInstanceState.colors[ColorOverride.MAT1]);
        materialParams.u_ColorAmbReg[0].copy(materialInstanceState.colors[ColorOverride.AMB0]);
        materialParams.u_ColorAmbReg[1].copy(materialInstanceState.colors[ColorOverride.AMB1]);
        materialParams.u_KonstColor[0].copy(materialInstanceState.colors[ColorOverride.K0]);
        materialParams.u_KonstColor[1].copy(materialInstanceState.colors[ColorOverride.K1]);
        materialParams.u_KonstColor[2].copy(materialInstanceState.colors[ColorOverride.K2]);
        materialParams.u_KonstColor[3].copy(materialInstanceState.colors[ColorOverride.K3]);
        materialParams.u_Color[0].copy(materialInstanceState.colors[ColorOverride.CPREV]);
        materialParams.u_Color[1].copy(materialInstanceState.colors[ColorOverride.C0]);
        materialParams.u_Color[2].copy(materialInstanceState.colors[ColorOverride.C1]);
        materialParams.u_Color[3].copy(materialInstanceState.colors[ColorOverride.C2]);

        // Bind textures.
        for (let i = 0; i < this.material.textureIndexes.length; i++) {
            const texIndex = this.material.textureIndexes[i];
            if (texIndex >= 0) {
                this.bmdModel.fillTextureMapping(materialParams.m_TextureMapping[i], textureHolder, texIndex);
            } else {
                materialParams.m_TextureMapping[i].glTexture = null;
            }
        }

        // Bind our texture matrices.
        const scratch = Command_Material.matrixScratch;
        for (let i = 0; i < this.material.texMatrices.length; i++) {
            const texMtx = this.material.texMatrices[i];
            if (texMtx === null)
                continue;

            const dst = materialParams.u_TexMtx[i];
            const flipY = materialParams.m_TextureMapping[i].flipY;
            const flipYScale = flipY ? -1.0 : 1.0;

            // First, compute input matrix.
            switch (texMtx.type) {
            case 0x00:
            case 0x01: // Delfino Plaza
            case 0x0B: // Luigi Circuit
            case 0x08: // Peach Beach.
                // No mapping.
                mat4.identity(dst);
                break;
            case 0x06: // Rainbow Road
            case 0x07: // Rainbow Road
                // Environment mapping. Uses the normal matrix.
                // Normal matrix. Emulated here by the view matrix with the translation lopped off...
                mat4.copy(dst, state.view);
                dst[12] = 0;
                dst[13] = 0;
                dst[14] = 0;
                break;
            case 0x09:
                // Projection. Used for indtexwater, mostly.
                mat4.copy(dst, state.view);
                break;
            default:
                throw "whoops";
            }

            // Now apply effects.
            switch(texMtx.type) {
            case 0x00:
            case 0x01:
            case 0x0B:
                break;
            case 0x06: // Rainbow Road
                // Environment mapping
                texEnvMtx(scratch, -0.5, -0.5 * flipYScale, 0.5, 0.5);
                mat4.mul(dst, scratch, dst);
                mat4.mul(dst, texMtx.effectMatrix, dst);
                break;
            case 0x07: // Rainbow Road
            case 0x08: // Peach Beach
                mat4.mul(dst, texMtx.effectMatrix, dst);
                texProjPerspMtx(scratch, state.fov, state.getAspect(), 0.5, -0.5 * flipYScale, 0.5, 0.5);
                mat4.mul(dst, scratch, dst);
                break;
            case 0x09: // Rainbow Road
                // Perspective.
                // Don't apply effectMatrix to perspective. It appears to be
                // a projection matrix preconfigured for GC.
                // mat4.mul(dst, texMtx.effectMatrix, dst);
                texProjPerspMtx(scratch, state.fov, state.getAspect(), 0.5, -0.5 * flipYScale, 0.5, 0.5);
                mat4.mul(dst, scratch, dst);
                break;
            default:
                throw "whoops";
            }

            // Apply SRT.
            mat4.copy(scratch, materialInstanceState.texMatrices[i]);

            // SRT matrices have translation in fourth component, but we want our matrix to have translation
            // in third component. Swap.
            const tx = scratch[12];
            scratch[12] = scratch[8];
            scratch[8] = tx;
            const ty = scratch[13];
            scratch[13] = scratch[9];
            scratch[9] = ty;

            mat4.mul(dst, scratch, dst);
        }

        for (let i = 0; i < this.material.postTexMatrices.length; i++) {
            const postTexMtx = this.material.postTexMatrices[i];
            if (postTexMtx === null)
                continue;

            const finalMatrix = postTexMtx.matrix;
            mat4.copy(materialParams.u_PostTexMtx[i], finalMatrix);
        }

        for (let i = 0; i < this.material.indTexMatrices.length; i++) {
            const indTexMtx = this.material.indTexMatrices[i];
            if (indTexMtx === null)
                continue;

            const a = indTexMtx[0], c = indTexMtx[1], tx = indTexMtx[2];
            const b = indTexMtx[3], d = indTexMtx[4], ty = indTexMtx[5];
            mat2d.set(materialParams.u_IndTexMtx[i], a, b, c, d, tx, ty);
        }
    }
}

export enum ColorOverride {
    MAT0, MAT1, AMB0, AMB1,
    K0, K1, K2, K3,
    CPREV, C0, C1, C2,
    COUNT,
}

const matrixScratch = mat4.create(), matrixScratch2 = mat4.create();

export class MaterialInstance {
    public ttk1Animators: TTK1Animator[] = [];
    public trk1Animators: TRK1Animator[] = [];

    constructor(private modelInstance: BMDModelInstance | null, private material: MaterialEntry) {
    }

    public bindTTK1(animationController: AnimationController, ttk1: TTK1): void {
        for (let i = 0; i < 8; i++) {
            const ttk1Animator = bindTTK1Animator(animationController, ttk1, this.material.name, i);
            if (ttk1Animator)
                this.ttk1Animators[i] = ttk1Animator;
        }
    }

    public bindTRK1(animationController: AnimationController, trk1: TRK1): void {
        for (let i: ColorOverride = 0; i < ColorOverride.COUNT; i++) {
            const trk1Animator = bindTRK1Animator(animationController, trk1, this.material.name, i);
            if (trk1Animator)
                this.trk1Animators[i] = trk1Animator;
        }
    }

    public fillMaterialInstanceState(materialInstanceState: MaterialInstanceState): void {
        const copyColor = (i: ColorOverride, fallbackColor: GX_Material.Color) => {
            const dst = materialInstanceState.colors[i];

            if (this.trk1Animators[i] !== undefined) {
                this.trk1Animators[i].calcColorOverride(dst);
                return;
            }

            let color: GX_Material.Color;
            if (this.modelInstance !== null && this.modelInstance.colorOverrides[i] !== undefined) {
                color = this.modelInstance.colorOverrides[i];
            } else {
                color = fallbackColor;
            }

            let alpha: number;
            if (this.modelInstance !== null && this.modelInstance.alphaOverrides[i]) {
                alpha = color.a;
            } else {
                alpha = fallbackColor.a;
            }
    
            dst.copy(color, alpha);
        };

        copyColor(ColorOverride.MAT0, this.material.colorMatRegs[0]);
        copyColor(ColorOverride.MAT1, this.material.colorMatRegs[1]);
        copyColor(ColorOverride.AMB0, this.material.colorAmbRegs[0]);
        copyColor(ColorOverride.AMB1, this.material.colorAmbRegs[1]);

        copyColor(ColorOverride.K0, this.material.gxMaterial.colorConstants[0]);
        copyColor(ColorOverride.K1, this.material.gxMaterial.colorConstants[1]);
        copyColor(ColorOverride.K2, this.material.gxMaterial.colorConstants[2]);
        copyColor(ColorOverride.K3, this.material.gxMaterial.colorConstants[3]);

        copyColor(ColorOverride.CPREV, this.material.gxMaterial.colorRegisters[0]);
        copyColor(ColorOverride.C0, this.material.gxMaterial.colorRegisters[1]);
        copyColor(ColorOverride.C1, this.material.gxMaterial.colorRegisters[2]);
        copyColor(ColorOverride.C2, this.material.gxMaterial.colorRegisters[3]);

        // Compute texture matrices.
        for (let i = 0; i < this.material.texMatrices.length; i++) {
            if (this.material.texMatrices[i] === null)
                continue;

            const dst = materialInstanceState.texMatrices[i];
            if (this.ttk1Animators[i] !== undefined) {
                this.ttk1Animators[i].calcTexMtx(dst);
            } else {
                mat4.copy(dst, this.material.texMatrices[i].matrix);
            }
        }
    }
}

class DrawListItem {
    constructor(
        public materialIndex: number,
        public shapeCommands: Command_Shape[] = [],
    ) {
    }
}

export class BMDModel {
    private realized: boolean = false;

    private glSamplers!: WebGLSampler[];
    private tex1Samplers!: TEX1_Sampler[];

    private bufferCoalescer: BufferCoalescer;

    public materialCommands: Command_Material[] = [];
    public shapeCommands: Command_Shape[] = [];
    public opaqueDrawList: DrawListItem[] = [];
    public transparentDrawList: DrawListItem[] = [];

    constructor(
        gl: WebGL2RenderingContext,
        public bmd: BMD,
        public bmt: BMT | null = null,
        public materialHacks?: GX_Material.GXMaterialHacks
    ) {
        const mat3 = (bmt !== null && bmt.mat3 !== null) ? bmt.mat3 : bmd.mat3;
        const tex1 = (bmt !== null && bmt.tex1 !== null) ? bmt.tex1 : bmd.tex1;

        this.tex1Samplers = tex1.samplers;
        this.glSamplers = this.tex1Samplers.map((sampler) => BMDModel.translateSampler(gl, sampler));

        // Load material data.
        this.materialCommands = mat3.materialEntries.map((material) => {
            return new Command_Material(this, material, this.materialHacks);
        });

        // Load shape data.
        const loadedVertexDatas = [];
        for (const shape of bmd.shp1.shapes)
            for (const packet of shape.packets)
                loadedVertexDatas.push(packet.loadedVertexData);
        this.bufferCoalescer = loadedDataCoalescer(gl, loadedVertexDatas);
        this.shapeCommands = bmd.shp1.shapes.map((shape, i) => {
            return new Command_Shape(gl, shape, this.bufferCoalescer.coalescedBuffers);
        });

        // Load scene graph.
        this.translateSceneGraph(bmd.inf1.sceneGraph, null);
        this.realized = true;
    }

    public destroy(gl: WebGL2RenderingContext): void {
        // TODO(jstpierre): Remove once we get rid of Scene.
        if (!this.realized)
            return;

        this.bufferCoalescer.destroy(gl);
        this.materialCommands.forEach((command) => command.destroy(gl));
        this.shapeCommands.forEach((command) => command.destroy(gl));
        this.glSamplers.forEach((sampler) => gl.deleteSampler(sampler));
        this.realized = false;
    }

    public fillTextureMapping(m: TextureMapping, textureHolder: J3DTextureHolder, texIndex: number): void {
        const tex1Sampler = this.tex1Samplers[texIndex];
        textureHolder.fillTextureMapping(m, tex1Sampler.name);
        m.glSampler = this.glSamplers[tex1Sampler.index];
        m.lodBias = tex1Sampler.lodBias;
    }

    private static translateSampler(gl: WebGL2RenderingContext, sampler: TEX1_Sampler): WebGLSampler {
        const glSampler = gl.createSampler();
        gl.samplerParameteri(glSampler, gl.TEXTURE_MIN_FILTER, translateTexFilter(gl, sampler.minFilter));
        gl.samplerParameteri(glSampler, gl.TEXTURE_MAG_FILTER, translateTexFilter(gl, sampler.magFilter));
        gl.samplerParameteri(glSampler, gl.TEXTURE_WRAP_S, translateWrapMode(gl, sampler.wrapS));
        gl.samplerParameteri(glSampler, gl.TEXTURE_WRAP_T, translateWrapMode(gl, sampler.wrapT));
        gl.samplerParameterf(glSampler, gl.TEXTURE_MIN_LOD, sampler.minLOD);
        gl.samplerParameterf(glSampler, gl.TEXTURE_MAX_LOD, sampler.maxLOD);
        return glSampler;
    }

    private translateSceneGraph(node: HierarchyNode, drawListItem: DrawListItem | null): void {
        switch (node.type) {
        case HierarchyType.Shape:
            drawListItem!.shapeCommands.push(this.shapeCommands[node.shapeIdx]);
            break;
        case HierarchyType.Material:
            const materialCommand = this.materialCommands[node.materialIdx];
            drawListItem = new DrawListItem(node.materialIdx);
            if (materialCommand.material.translucent)
                this.transparentDrawList.push(drawListItem);
            else
                this.opaqueDrawList.push(drawListItem);
            break;
        }

        for (const child of node.children)
            this.translateSceneGraph(child, drawListItem);
    }
}

export class BMDModelInstance {
    public name: string = '';
    public visible: boolean = true;
    public isSkybox: boolean = false;
    public fps: number = 30;

    public modelMatrix: mat4;

    public colorOverrides: GX_Material.Color[] = [];
    public alphaOverrides: boolean[] = [];
    public renderHelper: GXRenderHelper;
    private sceneParams = new SceneParams();

    // Animations.
    private animationController: AnimationController = new AnimationController();
    public ank1Animator: ANK1Animator | null = null;

    public currentMaterialCommand: Command_Material;

    // Temporary state when calculating bone matrices.
    private jointMatrices: mat4[];
    private jointVisibility: IntersectionState[];
    private bboxScratch: AABB = new AABB();

    private materialInstances: MaterialInstance[] = [];
    private materialInstanceState: MaterialInstanceState = new MaterialInstanceState();
    private shapeInstanceState: ShapeInstanceState = new ShapeInstanceState();

    constructor(
        gl: WebGL2RenderingContext,
        private textureHolder: J3DTextureHolder,
        private bmdModel: BMDModel,
    ) {
        this.renderHelper = new GXRenderHelper(gl);
        this.modelMatrix = mat4.create();

        this.materialInstances = this.bmdModel.materialCommands.map((materialCommand) => {
            return new MaterialInstance(this, materialCommand.material);
        });

        const numBones = this.bmdModel.bmd.jnt1.bones.length;
        this.jointMatrices = nArray(numBones, () => mat4.create());
        this.jointVisibility = nArray(numBones, () => IntersectionState.FULLY_INSIDE);

        const numVertexWeights = this.bmdModel.bmd.drw1.drw1Joints.length;
        this.shapeInstanceState.matrixArray = nArray(numVertexWeights, () => mat4.create());
        this.shapeInstanceState.matrixVisibility = nArray(numVertexWeights, () => IntersectionState.FULLY_INSIDE);
    }

    public destroy(gl: WebGL2RenderingContext) {
        this.bmdModel.destroy(gl);
        this.renderHelper.destroy(gl);
    }

    public setColorOverride(i: ColorOverride, color: GX_Material.Color, useAlpha: boolean = false): void {
        this.colorOverrides[i] = color;
        this.alphaOverrides[i] = useAlpha;
    }

    public setIsSkybox(v: boolean): void {
        this.isSkybox = v;
    }

    public setFPS(v: number): void {
        this.fps = v;
    }

    public setVisible(v: boolean): void {
        this.visible = v;
    }

    /**
     * Binds {@param ttk1} (texture animations) to this model renderer.
     * TTK1 objects can be parsed from {@link BTK} files. See {@link BTK.parse}.
     */
    public bindTTK1(ttk1: TTK1): void {
        for (let i = 0; i < this.materialInstances.length; i++) {
            this.materialInstances[i].bindTTK1(this.animationController, ttk1);
        }
    }

    /**
     * Binds {@param trk1} (color register animations) to this model renderer.
     * TRK1 objects can be parsed from {@link BRK} files. See {@link BRK.parse}.
     */
    public bindTRK1(trk1: TRK1): void {
        for (let i = 0; i < this.materialInstances.length; i++) {
            this.materialInstances[i].bindTRK1(this.animationController, trk1);
        }
    }

    /**
     * Binds {@param ank1} (joint animations) to this model renderer.
     * ANK1 objects can be parsed from {@link BCK} files. See {@link BCK.parse}.
     */
    public bindANK1(ank1: ANK1): void {
        this.ank1Animator = bindANK1Animator(this.animationController, ank1);
    }

    public getTimeInFrames(milliseconds: number) {
        return (milliseconds / 1000) * this.fps;
    }

    public bindState(state: RenderState): boolean {
        if (!this.visible)
            return false;

        // XXX(jstpierre): Is this the right place to do this? Need an explicit update call...
        this.animationController.updateTime(state.time);
        this.updateMatrixArray(state);

        // Update model matrix. TO
        mat4.copy(this.shapeInstanceState.modelMatrix, this.modelMatrix);
        this.shapeInstanceState.isSkybox = this.isSkybox;

        this.renderHelper.bindUniformBuffers(state);

        fillSceneParamsFromRenderState(this.sceneParams, state);
        this.renderHelper.bindSceneParams(state, this.sceneParams);

        return true;
    }

    private renderDrawList(state: RenderState, drawList: DrawListItem[]): void {
        for (let i = 0; i < drawList.length; i++) {
            const drawListItem = drawList[i];
            const materialIndex = drawListItem.materialIndex;
            const materialInstance = this.materialInstances[materialIndex];
            materialInstance.fillMaterialInstanceState(this.materialInstanceState);
            const materialCommand = this.bmdModel.materialCommands[materialIndex];
            materialCommand.bindMaterial(state, this.renderHelper, this.textureHolder, this.materialInstanceState);

            for (let j = 0; j < drawListItem.shapeCommands.length; j++) {
                const shapeCommand = drawListItem.shapeCommands[j];
                shapeCommand.draw(state, this.renderHelper, this.shapeInstanceState);
            }
        }
    }

    public renderOpaque(state: RenderState): void {
        this.renderDrawList(state, this.bmdModel.opaqueDrawList);
    }

    public renderTransparent(state: RenderState): void {
        this.renderDrawList(state, this.bmdModel.transparentDrawList);
    }

    public render(state: RenderState): void {
        if (!this.bindState(state))
            return;

        this.renderOpaque(state);
        this.renderTransparent(state);
    }

    private updateJointMatrixHierarchy(state: RenderState, node: HierarchyNode, parentJointMatrix: mat4): void {
        // TODO(jstpierre): Don't pointer chase when traversing hierarchy every frame...
        const jnt1 = this.bmdModel.bmd.jnt1;
        const bbox = this.bboxScratch;

        switch (node.type) {
        case HierarchyType.Joint:
            const jointIndex = node.jointIdx;

            let boneMatrix: mat4;
            if (this.ank1Animator !== null && this.ank1Animator.calcJointMatrix(matrixScratch2, jointIndex)) {
                boneMatrix = matrixScratch2;
            } else {
                boneMatrix = jnt1.bones[jointIndex].matrix;
            }

            const dstJointMatrix = this.jointMatrices[jointIndex];
            mat4.mul(dstJointMatrix, parentJointMatrix, boneMatrix);

            // Frustum cull.
            bbox.transform(jnt1.bones[jointIndex].bbox, dstJointMatrix);
            this.jointVisibility[jointIndex] = state.camera.frustum.intersect(bbox);

            // Now update children.
            for (let i = 0; i < node.children.length; i++)
                this.updateJointMatrixHierarchy(state, node.children[i], dstJointMatrix);
            break;
        default:
            // Pass through.
            for (let i = 0; i < node.children.length; i++)
                this.updateJointMatrixHierarchy(state, node.children[i], parentJointMatrix);
            break;
        }
    }

    private updateMatrixArray(state: RenderState): void {
        const inf1 = this.bmdModel.bmd.inf1;
        const drw1 = this.bmdModel.bmd.drw1;
        const evp1 = this.bmdModel.bmd.evp1;

        // First, update joint matrices from hierarchy.
        mat4.identity(matrixScratch);
        this.updateJointMatrixHierarchy(state, inf1.sceneGraph, matrixScratch);

        // Update weighted joint matrices.
        for (let i = 0; i < drw1.drw1Joints.length; i++) {
            const joint = drw1.drw1Joints[i];
            const dst = this.shapeInstanceState.matrixArray[i];
            if (joint.kind === DRW1JointKind.NormalJoint) {
                mat4.copy(dst, this.jointMatrices[joint.jointIndex]);
                this.shapeInstanceState.matrixVisibility[i] = this.jointVisibility[joint.jointIndex];
            } else if (joint.kind === DRW1JointKind.WeightedJoint) {
                dst.fill(0);
                const envelope = evp1.envelopes[joint.envelopeIndex];
                for (let i = 0; i < envelope.weightedBones.length; i++) {
                    const weightedBone = envelope.weightedBones[i];
                    const inverseBindPose = evp1.inverseBinds[weightedBone.index];
                    mat4.mul(matrixScratch, this.jointMatrices[weightedBone.index], inverseBindPose);
                    mat4.multiplyScalarAndAdd(dst, dst, matrixScratch, weightedBone.weight);
                }
                // TODO(jstpierre): Frustum cull weighted joints.
                this.shapeInstanceState.matrixVisibility[i] = IntersectionState.FULLY_INSIDE;
            }
        }
    }
}
