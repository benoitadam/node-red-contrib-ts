import { NodeAPI, Node, NodeDef } from 'node-red';
import * as vm from 'vm';
import ts from 'typescript';
import util from 'util';

interface TypeScriptNodeDef extends NodeDef {
    name: string;
    func: string;
    initialize?: string;
    finalize?: string;
    outputs: number;
    timeout?: number;
    useVm: boolean;
    updated?: number;
    libs?: Array<{var: string, module: string}>;
}

type Msg = {
    [name: string]: any
}

interface Compilation {
    updated: number;
    ready: Promise<void>;
    fun: (msg: Msg) => Promise<Msg|Msg[]>;
    ini: () => Promise<void>;
    fin: () => Promise<void>;
}

function compileTypeScript(node: Node, script: string): string {
    try {
        node.log(`Compiling TypeScript (${script.length} chars)`);
        
        const result = ts.transpileModule(script, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2020,
                module: ts.ModuleKind.CommonJS,
                moduleResolution: ts.ModuleResolutionKind.NodeJs,
                
                // Maximum permissiveness - allow everything
                allowJs: true,
                allowUnreachableCode: true,
                allowUnusedLabels: true,
                
                // Disable all strict checks
                strict: false,
                noImplicitAny: false,
                noImplicitThis: false,
                noImplicitReturns: false,
                noImplicitUseStrict: false,
                
                // Disable all error checking
                noUnusedLocals: false,
                noUnusedParameters: false,
                exactOptionalPropertyTypes: false,
                noUncheckedIndexedAccess: false,
                noPropertyAccessFromIndexSignature: false,
                
                // Skip all lib and declaration checks
                skipLibCheck: true,
                skipDefaultLibCheck: true,
                
                // Suppress warnings and errors
                suppressExcessPropertyErrors: true,
                suppressImplicitAnyIndexErrors: true,
                
                // Allow all JS features
                allowSyntheticDefaultImports: true,
                allowUmdGlobalAccess: true,
                
                // Disable emit checks
                noEmitOnError: false,
                
                // Maximum compatibility
                downlevelIteration: true,
                importHelpers: false
            }
        });
        
        // Check for TypeScript diagnostics
        if (result.diagnostics && result.diagnostics.length > 0) {
            const errors = result.diagnostics.map(diagnostic => {
                const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
                if (diagnostic.file && diagnostic.start !== undefined) {
                    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                    return `Line ${line + 1}:${character + 1}: ${message}`;
                }
                return message;
            }).join('\n');
            
            node.error(`TypeScript diagnostics:\n${errors}`);
        }
        
        node.log('TypeScript compilation successful');
        return result.outputText;
    } catch (error: any) {
        const json: any = {};
        try {
            json.stack = String(error.stack);
            json.message = String(error.message);
            json.errorKeys = Object.keys(error);
        } catch(e) {}
        try {
            const prototype = Object.getPrototypeOf(error);
            json.prototypeType = String(typeof prototype);
            json.prototypeKeys = Object.keys(prototype);
            json.prototypeName = String(prototype.name);
        } catch(e) {}
        throw new Error(`Compilation failed: ${JSON.stringify(json)}`);
    }
}

async function injectModules(context: any, libs: any[], RED: any, node: Node): Promise<void> {
    if (!libs || libs.length === 0) return;
    
    const moduleLoadPromises = libs.map(async (lib) => {
        const vname = lib.var;
        if (!vname || vname === '') return;
        
        if (context.hasOwnProperty(vname) || vname === 'node') {
            throw new Error(`Module variable name '${vname}' is reserved or already exists`);
        }
        
        try {
            // Use RED.import() as in the original code
            const loadedModule = await RED.import(lib.module);
            context[vname] = loadedModule.default || loadedModule;
        } catch (err: any) {
            node.error(`Failed to load module '${lib.module}': ${err.message}`);
            throw err;
        }
    });
    
    await Promise.all(moduleLoadPromises);
}

async function newCompilation(node: TsNode, comp: Compilation, def: TypeScriptNodeDef, RED: any): Promise<void> {
    const useVm = def.useVm === true;
    const libs = def.libs || [];

    const funTs = def.func || '';
    const iniTs = def.initialize || '';
    const finTs = def.finalize || '';
    const timeout = Number(def.timeout) || undefined;
    
    const funJs = compileTypeScript(node, `(async function() { ${funTs} })()`);
    const iniJs = compileTypeScript(node, `(async function() { ${iniTs} })()`);
    const finJs = compileTypeScript(node, `(async function() { ${finTs} })()`);
    
    const nodeContext = node.context();
    const ctx: any = {
        msg: {},
        node,
        RED,
        __global: global,
        console,
        util,
        Buffer: Buffer,
        URL: URL,
        URLSearchParams: URLSearchParams,
        Date: Date,
        require,
        fetch,
        context: nodeContext,
        flow: nodeContext.flow,
        global: nodeContext.global,
        env: {
            get: (envVar: any) => RED.util.getSetting(node, envVar)
        },
        setTimeout: (handler: Function, delayMs?: number) => {
            const id = setTimeout(() => {
                ctx.clearTimeout(id);
                try {
                    handler();
                } catch(err) {
                    node.error(err, {});
                }
            }, delayMs);
            (node as any).outstandingTimers.push(id);
            return id;
        },
        clearTimeout: (id: any) => {
            clearTimeout(id);
            var index = (node as any).outstandingTimers.indexOf(id);
            if (index > -1) {
                (node as any).outstandingTimers.splice(index,1);
            }
        },
        setInterval: (handler: Function, delayMs?: number) => {
            const id = setInterval(() => {
                try {
                    handler();
                } catch(err) {
                    node.error(err,{});
                }
            }, delayMs);
            (node as any).outstandingIntervals.push(id);
            return id;
        },
        clearInterval: (id: any) => {
            clearInterval(id);
            var index = (node as any).outstandingIntervals.indexOf(id);
            if (index > -1) {
                (node as any).outstandingIntervals.splice(index,1);
            }
        },
    };

    // Inject modules (including default ones defined in HTML)
    await injectModules(ctx, libs, RED, node);

    if (!useVm) {
        const funArgs = Object.keys(ctx);

        const fun = new Function(...funArgs, `return ${funJs}`);
        const ini = new Function(...funArgs, `return ${iniJs}`);
        const fin = new Function(...funArgs, `return ${finJs}`);

        comp.fun = async (msg) => {
            ctx.msg = msg;
            return fun(...funArgs.map(k => ctx[k]));
        }
        comp.ini = () => ini(...funArgs.map(k => ctx[k]));
        comp.fin = () => fin(...funArgs.map(k => ctx[k]));
    }
    else {
        const vmCtx = vm.createContext(ctx);
        const vmOptions: vm.RunningCodeOptions = {
            timeout,
            displayErrors: true
        };
        
        comp.fun = (msg) => {
            vmCtx.msg = msg;
            return vm.runInContext(funJs, vmCtx, vmOptions);
        };
        comp.ini = () => vm.runInContext(iniJs, vmCtx, vmOptions);
        comp.fin = () => vm.runInContext(finJs, vmCtx, vmOptions);
    }

    try {
        await comp.ini();
    }
    catch (error: any) {
        node.error('Error in function initialize: ' + (error.stack || error.message))
    }
}

async function getCompilation(node: TsNode, def: TypeScriptNodeDef, RED: any): Promise<Compilation|undefined> {
    try {
        const updated: number = def.updated || 0;

        if (node.comp?.updated !== updated) {
            try {
                await node.comp?.fin();
            } catch (error: any) {
                node.error('Error in function finalize: ' + (error.stack || error.message));
            }
            node.comp = {
                updated,
                ready: Promise.resolve(),
                fun: () => { throw 'no fun' },
                ini: () => { throw 'no ini' },
                fin: () => { throw 'no fin' },
            };
            node.comp.ready = newCompilation(node, node.comp, def, RED);
        }

        await node.comp.ready;
        return node.comp;
    } catch (error: any) {
        node.error('Compilation error: ' + (error.stack || error.message));
        return undefined;
    }
}

interface TsNode extends Node {
    comp: Compilation | undefined;
}

export = (RED: NodeAPI) => {
    const TypeScriptNode = function(this: TsNode, def: TypeScriptNodeDef) {
        RED.nodes.createNode(this, def);

        // Precompile on node creation
        getCompilation(this, def, RED);
        
        this.on('input', async (msg: any) => {
            const comp = await getCompilation(this, def, RED);
            if (!comp) return;

            try {
                const outputs = await comp.fun(msg);
                this.send(outputs);
            } catch (error: any) {
                this.error('Error in function execution: ' + (error.stack || error.message));
            }
        });
        
        // Clean up compilation on node close
        this.on('close', async () => {
            try {
                if (this.comp) await this.comp.fin();
            } catch (error: any) {
                this.error('Error in function finalize: ' + (error.stack || error.message));
            }

            delete this.comp;
        });
    };
    
    RED.nodes.registerType("typescript", TypeScriptNode);
};