import {
	aws_cloudfront as cloudfront,
	aws_cloudfront_origins as origins,
	aws_iam as iam,
	aws_ivs as ivs,
	aws_lambda_nodejs as lambda,
	aws_s3 as s3,
	aws_s3_notifications as s3n,
	CfnOutput,
	Duration,
	Stack,
	StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import { allowedOrigins, channelType } from "../config.json";
import { getLambdaEntryPath } from "./utils";

export class DVRdemoStack extends Stack {
	constructor(scope: Construct, id: string, props?: StackProps) {
		super(scope, id, props);

		/**
		 * S3 bucket where the VOD content will be stored --> TODO: make 4 with unique path?
		 */
		const bucket = new s3.Bucket(this, "vod-record-bucket");
		const { bucketName: vodBucketName } = bucket;

		/**
		 * IVS Channel Recording Configuration --> TODO: make 4?
		 */
		const recordingConfig = new ivs.CfnRecordingConfiguration(
			this,
			"dvr-recording-config",
			{
				name: "dvr-recording-config",
				destinationConfiguration: { s3: { bucketName: vodBucketName } },
				thumbnailConfiguration: { recordingMode: "DISABLED" },
			}
		);
		const { attrArn: recordingConfigurationArn } = recordingConfig;

		/**
		 * IVS Channel --> TODO: make 4
		 */
		const overviewChannel = new ivs.CfnChannel(this, "Overview-channel", {
			latencyMode: "LOW",
			name: "Overview-channel",
			recordingConfigurationArn,
			type: channelType,
		});

		// Extract
		const {
			attrArn: overviewChannelArn,
			attrPlaybackUrl: overviewPlaybackUrl,
			attrIngestEndpoint: overviewIngestEndpoint,
		} = overviewChannel;

		const screensChannel = new ivs.CfnChannel(this, "Screens-channel", {
			latencyMode: "LOW",
			name: "Screens-channel",
			recordingConfigurationArn,
			type: channelType,
		});
		const {
			attrArn: screensChannelArn,
			attrPlaybackUrl: screensPlaybackUrl,
			attrIngestEndpoint: screensIngestEndpoint,
		} = screensChannel;

		// Stream configuration values --> TODO: make 4
		const overviewIngestServer = `rtmps://${overviewIngestEndpoint}:443/app/`;
		const { attrValue: overviewStreamKey } = new ivs.CfnStreamKey(
			this,
			"overview-dvr-streamkey",
			{ channelArn: overviewChannelArn }
		);

		const screensIngestServer = `rtmps://${screensIngestEndpoint}:443/app/`;
		const { attrValue: screensStreamKey } = new ivs.CfnStreamKey(
			this,
			"screens-dvr-streamkey",
			{ channelArn: screensChannelArn }
		);

		// IAM policy statement with GetStream permissions to the IVS channel (attached to the Lambda functions that require it)
		const getStreamPolicy = new iam.PolicyStatement({
			actions: ["ivs:GetStream"],
			effect: iam.Effect.ALLOW,
			resources: [overviewChannelArn, screensChannelArn], // --> TODO: Add 4 channelArns
		});

		/**
		 * Lambda(at)Edge function triggered on Origin Requests to process playlist rendition files
		 */
		const modifyRenditionPlaylistLambda = new lambda.NodejsFunction(
			this,
			"ModifyRenditionPlaylistHandler",
			{
				bundling: { minify: true },
				entry: getLambdaEntryPath("modifyRenditionPlaylist"),
			}
		);

		// Grant the Lambda execution role Read permissions to the VOD S3 bucket
		bucket.grantRead(modifyRenditionPlaylistLambda, "*/playlist.m3u8");

		// Grant the Lambda execution role GetStream permissions to the IVS channel
		modifyRenditionPlaylistLambda.addToRolePolicy(getStreamPolicy);

		/**
		 * Lambda function invoked by an S3 Event Notification to save the latest recording-started.json file
		 */
		const saveRecordingStartMetaLambda = new lambda.NodejsFunction(
			this,
			"SaveRecordingStartMetaHandler",
			{
				bundling: { minify: true },
				entry: getLambdaEntryPath("saveRecordingStartMeta"),
			}
		);

		// Grant the Lambda execution role Read and Put permissions to the VOD S3 bucket
		bucket.grantRead(
			saveRecordingStartMetaLambda,
			"*/recording-started.json"
		);
		bucket.grantPut(
			saveRecordingStartMetaLambda,
			"recording-started-latest*.json"
		);

		// Grant the Lambda execution role GetStream permissions to the IVS channel
		saveRecordingStartMetaLambda.addToRolePolicy(getStreamPolicy);

		// Add an S3 Event Notification that invokes the saveRecordingStartMeta Lambda function when a recording-started.json object is created in the VOD S3 bucket
		bucket.addEventNotification(
			s3.EventType.OBJECT_CREATED_PUT,
			new s3n.LambdaDestination(saveRecordingStartMetaLambda),
			{ suffix: "recording-started.json" }
		);

		/**
		 * Lambda(at)Edge function triggered on Origin Requests to retrieve the recording-started-latest.json metadata file
		 */
		const getLatestRecordingStartMetaLambda = new lambda.NodejsFunction(
			this,
			"GetLatestRecordingStartMetaHandler",
			{
				bundling: { minify: true },
				entry: getLambdaEntryPath("getLatestRecordingStartMeta"),
			}
		);

		// Grant the Lambda execution role Read permissions to the VOD S3 bucket
		bucket.grantRead(
			getLatestRecordingStartMetaLambda,
			"recording-started-latest*.json"
		);
		bucket.grantRead(getLatestRecordingStartMetaLambda, "*/playlist.m3u8");

		// Grant the Lambda execution role GetStream permissions to the IVS channel
		getLatestRecordingStartMetaLambda.addToRolePolicy(getStreamPolicy);

		/**
		 * Origin Access Identity (OAI) that CloudFront will use to access the S3 bucket --> TODO: Create 4
		 */
		const oai = new cloudfront.OriginAccessIdentity(this, "vod-oai");
		const origin = new origins.S3Origin(bucket, {
			originAccessIdentity: oai,
			customHeaders: {
				"vod-record-bucket-name": vodBucketName,
				"overview-channel-arn": overviewChannelArn,
				"screens-channel-arn": screensChannelArn,
			},
		});
		/**
		 * Custom Cache Policy to allow max-age caching values between 0 seconds and 1 year
		 */
		const playlistCachePolicy = new cloudfront.CachePolicy(
			this,
			"VOD-PlaylistCaching",
			{
				cachePolicyName: "VOD-PlaylistCaching",
				comment: "Policy for VOD Playlist Origin",
				defaultTtl: Duration.seconds(30),
				maxTtl: Duration.days(365),
				minTtl: Duration.seconds(0),
				enableAcceptEncodingGzip: true,
			}
		);

		/**
		 * Custom Response Headers Policy to allow only the required origins for CORS requests
		 */
		const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
			this,
			"VOD-ResponseHeaders",
			{
				responseHeadersPolicyName: "VOD-ResponseHeaders",
				comment: "Allows only the required origins for CORS requests",
				corsBehavior: {
					accessControlAllowCredentials: false,
					accessControlAllowHeaders: ["*"],
					accessControlAllowMethods: ["GET"],
					accessControlAllowOrigins: allowedOrigins,
					originOverride: true,
				},
			}
		);

		/**
		 * CloudFront Distribution for accessing video content from the VOD S3 Origin --> TODO: Test if this needs to be separate distributions or if all can be included in this one
		 */
		const distribution = new cloudfront.Distribution(this, "vod-cdn", {
			// Default caching behaviour for fetching video content files (.ts) directly from the VOD S3 bucket
			defaultBehavior: {
				origin,
				originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
				responseHeadersPolicy,
			},
			additionalBehaviors: {
				// Caching behaviour for invoking a Lambda@Edge function on Origin Requests to fetch and modify a playlist rendition file from the VOD S3 bucket
				"*/playlist.m3u8": {
					origin,
					originRequestPolicy:
						cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
					responseHeadersPolicy,
					cachePolicy: playlistCachePolicy,
					edgeLambdas: [
						{
							functionVersion:
								modifyRenditionPlaylistLambda.currentVersion,
							eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
						},
					],
				},
				// Caching behaviour for invoking a Lambda@Edge function on Origin Requests to fetch the recording-started-latest.json metadata file from the VOD S3 bucket with caching DISABLED
				"recording-started-latest*.json": {
					origin,
					originRequestPolicy:
						cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
					responseHeadersPolicy,
					cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
					edgeLambdas: [
						{
							functionVersion:
								getLatestRecordingStartMetaLambda.currentVersion,
							eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
						},
					],
				},
			},
		});
		const { domainName } = distribution;

		/**
		 * Stack Outputs -->
		 */
		// Overview
		new CfnOutput(this, "overviewIngestServer", {
			value: overviewIngestServer,
		});
		new CfnOutput(this, "overviewStreamKey", { value: overviewStreamKey });
		new CfnOutput(this, "overviewPlaybackUrl", {
			value: overviewPlaybackUrl,
		});

		// Screens
		new CfnOutput(this, "screensIngestServer", {
			value: screensIngestServer,
		});
		new CfnOutput(this, "screensStreamKey", { value: screensStreamKey });
		new CfnOutput(this, "screensPlaybackUrl", {
			value: screensPlaybackUrl,
		});

		// Domain
		new CfnOutput(this, "distributionDomainName", { value: domainName });
	}
}
