import { CloudFrontRequestEvent } from "aws-lambda";
import { StreamState } from "@aws-sdk/client-ivs";

import {
	getS3Object,
	getActiveStream,
	createResponse,
	isS3Error,
} from "./utils";
import { Source } from "aws-cdk-lib/aws-codebuild";

enum SourcePosition {
	Overview = "OVERVIEW",
	Instruments = "INSTRUMENTS",
	Captain = "CAPTAIN",
	FO = "FO",
	Unknown = "UNKNOWN",
}

interface RecordingStartedMetadata {
	isChannelLive: boolean;
	livePlaybackUrl?: string;
	masterKey?: string;
	recordingStartedAt?: string;
	playlistDuration?: number;
	channelId: String;
	sourcePosition: String;
}

/**
 * Triggered on Origin Requests to retrieve the recording-started-latest.json metadata file
 * from the VOD S3 bucket. A response is generated to contain only the required fields from
 * the metadata file, along with the live playbackUrl and an indicator for whether or not
 * the channel has an active (live) stream.
 *
 * Responses are sent with a no-cache Cache-Control directive to ensure that the browser does
 * not cache the response object (note that this Lambda(at)Edge function is already configured
 * with the managed CachingDisabled cache policy to ensure that CloudFront does not cache this
 * object either).
 *
 * If S3 throws a NoSuchKey (404) error, this is likely because we requested the metadata file before
 * the recording-started.json file was created by Amazon IVS and saved into the S3 VOD bucket by the S3 Event
 * Notification Lambda function (saveRecordingStartMeta). Therefore, instead of responding with the 404
 * status code, we send a 200 status code and an empty body, which will be handled accordingly on the
 * client-side. This prevents any unnecessary errors from being thrown on the client-side from this type
 * of event, which we know will occur frequently when the channel first starts recording.
 *
 * @param event CloudFront Origin Request event
 */
const getLatestRecordingStartMeta = async (event: CloudFrontRequestEvent) => {
	const { origin, uri } = event.Records[0].cf.request;
	const customHeaders = origin!.s3!.customHeaders;
	const overviewChannelArn =
		customHeaders["overview-channel-arn"][0].value || "";
	const instrumentsChannelArn =
		customHeaders["instruments-channel-arn"][0].value || "";
	const captChannelArn = customHeaders["capt-channel-arn"][0].value || "";
	const foChannelArn = customHeaders["fo-channel-arn"][0].value || "";

	const bucketName = customHeaders["vod-record-bucket-name"][0].value || "";
	const key = uri.slice(1);
	let response;

	try {
		// Get recording-started-latest.json file
		const { body: jsonBody } = await getS3Object(key, bucketName);
		const {
			media: {
				hls: { path, playlist, renditions },
			},
			recording_started_at: recordingStartedAt,
			streamId: recordedStreamId,
			channelId: channelId,
			channel_arn: channelArn,
		} = JSON.parse(jsonBody);

		const activeStream = await getActiveStream(channelArn);
		const {
			playbackUrl: livePlaybackUrl,
			state: channelState,
			streamId: activeStreamId,
		} = activeStream || {};
		const isChannelLive = channelState === StreamState.StreamLive;

		// Check for which channel the playlist is requested to assign the right arn
		// Example ARN: arn:aws:ivs:us-east-1:667901935354:channel/44USK7rjNnSh
		// Example path: s3://dvrdemostack-vodrecordbucket7dc8b4c7-1btsazxj4r69p/ivs/v1/667901935354/44USK7rjNnSh/2023/2/13/16/19/ayj1JvYhySGJ/events/recording-started.json

		var sourcePosition = SourcePosition.Unknown;

		if (channelArn == overviewChannelArn) {
			// Channel is overview
			sourcePosition = SourcePosition.Overview;
		} else if (channelArn == instrumentsChannelArn) {
			// Channel is instruments
			sourcePosition = SourcePosition.Instruments;
		} else if (channelArn == captChannelArn) {
			// Channel is capt
			sourcePosition = SourcePosition.Captain;
		} else if (channelArn == foChannelArn) {
			// Channel is FO
			sourcePosition = SourcePosition.FO;
		}

		// Build response body
		const recordingStartedMetadata: RecordingStartedMetadata = {
			isChannelLive,
			livePlaybackUrl: isChannelLive ? livePlaybackUrl : "",
			channelId,
			sourcePosition,
		};

		// Only return VOD metadata if the recorded stream metadata is for the currently live stream (if one exists) --> TODO: Change? We also want VOD data when stream is stopped + do for all 4 streams
		// if (recordedStreamId === activeStreamId) {
		recordingStartedMetadata.masterKey = `${path}/${playlist}`;
		recordingStartedMetadata.recordingStartedAt = recordingStartedAt;

		try {
			const [highestRendition] = renditions;
			const renditionKey = `${path}/${highestRendition.path}/${highestRendition.playlist}`;
			const { body: textBody } = await getS3Object(renditionKey, bucketName);
			const regExp = /EXT-X-TWITCH-TOTAL-SECS:(.+)$/m;
			const match = textBody.match(regExp)?.[1];

			if (match) {
				recordingStartedMetadata.playlistDuration = parseInt(match);
			}
		} catch (error) {
			/**
			 * Error out silently:
			 * playlistDuration is only required for iOS devices when working with an open VOD playlist, other devices will get this value from the player instance on the FE.
			 */
		}
		// }

		response = createResponse(200, {
			body: JSON.stringify(recordingStartedMetadata),
			contentType: "application/json",
			maxAge: 1,
		});
	} catch (error) {
		if (isS3Error(error) && error.Code === "NoSuchKey") {
			// TODO: --> Included error message that stream is not running yet
			response = createResponse(200, {
				maxAge: 1,
				body: JSON.stringify(null),
			});
		} else {
			console.error(error);
			response = createResponse(500, { maxAge: 1 });
		}
	}

	return response;
};

export const handler = getLatestRecordingStartMeta;
