import { Distribution, Version, Module, Type, TypeMetadata, Required as HeliosRequired, JavaPlatformOptions, Platform, JdkDistribution } from 'hellmc-distribution-types'
import { MavenComponents, MavenUtil } from '../util/MavenUtil'
import { join } from 'path'
import { LoggerUtil } from '../../util/LoggerUtil'
import { mcVersionAtLeast } from '../util/MojangUtils'

const logger = LoggerUtil.getLogger('DistributionFactory')

/**
 * Merge helper for `JavaOptions`/`JavaPlatformOptions` resolution. Not part of
 * the wire format (see `hellmc-distribution-types`), purely an internal
 * accumulator for {@link HeliosVersion.parseEffectiveJavaOptions}.
 */
interface JavaVersionProps {
    distribution?: JdkDistribution
    supported?: string
    suggestedMajor?: number
}

export class HeliosDistribution {

    public readonly versions: HeliosVersion[]

    constructor(
        public readonly rawDistribution: Distribution,
        commonDir: string,
        instanceDir: string
    ) {
        if(this.rawDistribution.versions.length === 0) {
            logger.warn('Distribution has 0 configured versions. This doesnt seem right..')
        }
        this.versions = this.rawDistribution.versions.map(v => new HeliosVersion(v, commonDir, instanceDir))
    }

    /**
     * Fase 0: there is no `Server` catalog yet to mark a "main"/recommended
     * entry, so the first published version (by the distribution's own
     * `sortOrder`) is the default. Superseded in fase 1 by `Server.mainServer`
     * + the server's `recommended` version.
     */
    public getMainVersion(): HeliosVersion | null {
        return this.versions.length > 0 ? this.versions[0] : null
    }

    public getVersionById(id: string): HeliosVersion | null {
        return this.versions.find(v => v.rawVersion.id === id) || null
    }

}

export class HeliosVersion {

    public readonly modules: HeliosModule[]
    public readonly effectiveJavaOptions: Required<JavaVersionProps>

    constructor(
        public readonly rawVersion: Version,
        commonDir: string,
        instanceDir: string
    ) {
        this.effectiveJavaOptions = this.parseEffectiveJavaOptions()
        this.modules = rawVersion.modules.map(m => new HeliosModule(m, rawVersion.id, commonDir, instanceDir))
    }

    private parseEffectiveJavaOptions(): Required<JavaVersionProps> {

        const options: JavaPlatformOptions[] = this.rawVersion.javaOptions?.platformOptions ?? []

        const mergeableProps: JavaVersionProps[] = []
        for(const option of options) {

            if (option.platform === process.platform) {
                if (option.architecture === process.arch) {
                    mergeableProps[0] = option
                } else {
                    mergeableProps[1] = option
                }
            }
        }
        mergeableProps[3] = {
            distribution: this.rawVersion.javaOptions?.distribution,
            supported: this.rawVersion.javaOptions?.supported,
            suggestedMajor: this.rawVersion.javaOptions?.suggestedMajor
        }

        const merged: JavaVersionProps = {}
        for(let i=mergeableProps.length-1; i>=0; i--) {
            if(mergeableProps[i] != null) {
                merged.distribution = mergeableProps[i].distribution
                merged.supported = mergeableProps[i].supported
                merged.suggestedMajor = mergeableProps[i].suggestedMajor
            }
        }

        return this.defaultUndefinedJavaOptions(merged)
    }

    private defaultUndefinedJavaOptions(props: JavaVersionProps): Required<JavaVersionProps> {
        const [defaultRange, defaultSuggestion] = this.defaultJavaVersion()
        return {
            supported: props.supported ?? defaultRange,
            distribution: props.distribution ?? this.defaultJavaPlatform(),
            suggestedMajor: props.suggestedMajor ?? defaultSuggestion,
        }
    }

    private defaultJavaVersion(): [string, number] {
        if(mcVersionAtLeast('1.20.5', this.rawVersion.minecraftVersion)) {
            return ['>=21.x', 21]
        } else if(mcVersionAtLeast('1.17', this.rawVersion.minecraftVersion)) {
            return ['>=17.x', 17]
        } else {
            return ['8.x', 8]
        }
    }

    private defaultJavaPlatform(): JdkDistribution {
        return process.platform === Platform.DARWIN ? JdkDistribution.CORRETTO : JdkDistribution.TEMURIN
    }

}

export class HeliosModule {

    public readonly subModules: HeliosModule[]

    private readonly mavenComponents: Readonly<MavenComponents>
    private readonly required: Readonly<Required<HeliosRequired>>
    private readonly localPath: string

    constructor(
        public readonly rawModule: Module,
        private readonly versionId: string,
        commonDir: string,
        instanceDir: string
    ) {

        this.mavenComponents = this.resolveMavenComponents()
        this.required = this.resolveRequired()
        this.localPath = this.resolveLocalPath(commonDir, instanceDir)

        if(this.rawModule.subModules != null) {
            this.subModules = this.rawModule.subModules.map(m => new HeliosModule(m, versionId, commonDir, instanceDir))
        } else {
            this.subModules = []
        }

    }

    private resolveMavenComponents(): MavenComponents {

        // Files need not have a maven identifier if they provide a path.
        if(this.rawModule.type === Type.File && this.rawModule.artifact.path != null) {
            return null! as MavenComponents
        }
        // Version Manifests never provide a maven identifier.
        if(this.rawModule.type === Type.VersionManifest) {
            return null! as MavenComponents
        }

        const isMavenId = MavenUtil.isMavenIdentifier(this.rawModule.id)

        if(!isMavenId) {
            if(this.rawModule.type !== Type.File) {
                throw new Error(`Module ${this.rawModule.name} (${this.rawModule.id}) of type ${this.rawModule.type} must have a valid maven identifier!`)
            } else {
                throw new Error(`Module ${this.rawModule.name} (${this.rawModule.id}) of type ${this.rawModule.type} must either declare an artifact path or have a valid maven identifier!`)
            }
        }

        try {
            return MavenUtil.getMavenComponents(this.rawModule.id)
        } catch(err) {
            throw new Error(`Failed to resolve maven components for module ${this.rawModule.name} (${this.rawModule.id}) of type ${this.rawModule.type}. Reason: ${(err as Error).message}`)
        }

    }

    private resolveRequired(): Required<HeliosRequired> {
        if(this.rawModule.required == null) {
            return {
                value: true,
                def: true
            }
        } else {
            return {
                value: this.rawModule.required.value ?? true,
                def: this.rawModule.required.def ?? true
            }
        }
    }

    private resolveLocalPath(commonDir: string, instanceDir: string): string {

        // Version Manifests have a pre-determined path.
        if(this.rawModule.type === Type.VersionManifest) {
            return join(commonDir, 'versions', this.rawModule.id, `${this.rawModule.id}.json`)
        }

        const relativePath = this.rawModule.artifact.path ?? MavenUtil.mavenComponentsAsNormalizedPath(
            this.mavenComponents.group,
            this.mavenComponents.artifact,
            this.mavenComponents.version,
            this.mavenComponents.classifier,
            this.mavenComponents.extension
        )

        const meta = TypeMetadata[this.rawModule.type]
        if(meta.storage === 'instance' || meta.baseDirectory == null) {
            return join(instanceDir, this.versionId, relativePath)
        }
        return join(commonDir, meta.baseDirectory, relativePath)

    }

    public hasMavenComponents(): boolean {
        return this.mavenComponents != null
    }

    public getMavenComponents(): Readonly<MavenComponents> {
        return this.mavenComponents
    }

    public getRequired(): Readonly<Required<HeliosRequired>> {
        return this.required
    }

    public getPath(): string {
        return this.localPath
    }

    public getMavenIdentifier(): string {
        return MavenUtil.mavenComponentsToIdentifier(
            this.mavenComponents.group,
            this.mavenComponents.artifact,
            this.mavenComponents.version,
            this.mavenComponents.classifier,
            this.mavenComponents.extension
        )
    }

    public getExtensionlessMavenIdentifier(): string {
        return MavenUtil.mavenComponentsToExtensionlessIdentifier(
            this.mavenComponents.group,
            this.mavenComponents.artifact,
            this.mavenComponents.version,
            this.mavenComponents.classifier
        )
    }

    public getVersionlessMavenIdentifier(): string {
        return MavenUtil.mavenComponentsToVersionlessIdentifier(
            this.mavenComponents.group,
            this.mavenComponents.artifact,
            this.mavenComponents.classifier
        )
    }

    public hasSubModules(): boolean {
        return this.subModules.length > 0
    }

}
