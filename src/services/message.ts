import { timestampConverter } from '@/utils/firestore';
import { storage, db } from '@/firebase';
import {
	arrayRemove,
	arrayUnion,
	collection,
	doc,
	setDoc,
	Timestamp,
	writeBatch,
	deleteDoc,
	onSnapshot,
	getDocs,
	updateDoc,
	limit,
	query,
	orderBy,
	startAfter,
	DocumentReference,
	UpdateData,
	FirestoreDataConverter,
	QueryDocumentSnapshot,
} from 'firebase/firestore';
import {
	ref as storageRef,
	uploadBytesResumable,
	uploadString,
	getBlob,
	getBytes,
	deleteObject,
} from 'firebase/storage';
import { AuthService } from '@/services/auth';
import { UserService, DisplayUserInfo } from '@/services/user';
import { fbErrorHandler as errorHandler } from '@/utils/errorHandler';
import { encode } from 'base64-arraybuffer';
import { useMessagesStore, Direction } from '@/stores/messages';
import { useLoadingStore } from '@/stores/loading';
import {
	AttachmentType,
	ContentType,
	Message as DBMessage,
	MessageAttachment as DBMessageAttachment,
	MessageContent as DBMessageContent,
} from '@/types/db/MessagesTable';
import { ChatInfo, ChatService } from '@/services/chat';
import { EditMessageData } from '@/components/chat/form/MessageForm.vue';
import { ParsedTimestamps } from '@/types/db/helpers';
import { ThumbResult } from '@/utils/resizeFile';

type MessageWithId = ParsedTimestamps<DBMessage> & { id: DocumentReference['id'] };

export interface Message extends Omit<MessageWithId, 'sender' | 'content'> {
	content: MessageContent;
	sender: DisplayUserInfo;
}

export type MessageContent<T extends ContentType = ContentType> = T extends AttachmentType
	? Omit<DBMessageContent, 'attachments'> & {
			attachments: MessageAttachment[];
	  }
	: Omit<DBMessageContent, 'attachments'>;

export interface MessageAttachment<T extends AttachmentType = AttachmentType>
	extends Omit<DBMessageAttachment<T>, 'thumbnail'> {
	thumbnail: T extends 'media' ? string | null : never;
	raw: DBMessageAttachment<T>['raw'] & { previewURL?: T extends 'media' ? string : never };
}

export type MediaAttachment = MessageAttachment<'media'>;
export type FileAttachment = MessageAttachment<'file'>;

export interface CreateMsgForm<T extends ContentType = ContentType> extends Pick<MessageContent, 'text' | 'type'> {
	type: T;
	attachments: T extends AttachmentType ? FormAttachment<T>[] : never;
}

export type FormAttachment<T extends AttachmentType = AttachmentType> = {
	id: string;
	fileData: File;
} & (T extends 'file'
	? {}
	: {
			thumbnail: ThumbResult;
			sizes: DBMessageAttachment<'media'>['raw']['sizes'];
	  });

export class MessagesService {
	private static messageConverter: FirestoreDataConverter<MessageWithId, DBMessage> = {
		toFirestore: ({ id, ...msg }) => timestampConverter().toFirestore(msg) as DBMessage,
		fromFirestore: (snapshot: QueryDocumentSnapshot<MessageWithId, DBMessage>, options) => {
			const chat = timestampConverter<DBMessage>().fromFirestore(snapshot, options);
			return { ...chat, id: snapshot.ref.id } as MessageWithId;
		},
	};

	private static getMessagesCol(chatId: ChatInfo['id']) {
		return collection(doc(ChatService.chatCol, chatId), 'messages').withConverter(this.messageConverter);
	}

	private static getMessageDocRef(chatId: ChatInfo['id'], mId: Message['id']) {
		return doc(MessagesService.getMessagesCol(chatId), mId);
	}

	static async fetchMessages(chatId: ChatInfo['id'], lmt: number = 10) {
		const messagesStore = useMessagesStore();
		const messagesCol = this.getMessagesCol(chatId);
		const q = query(messagesCol, orderBy('created_at', 'desc'), limit(lmt));
		messagesStore.setFirstLoading(true);
		return onSnapshot(q, async messagesRef => {
			try {
				const snapshots = await Promise.all(
					messagesRef.docChanges().map(async change => {
						const msgData = change.doc.data();
						if (change.type === 'added' || change.type === 'modified') {
							return {
								message: await this.getFullMessageInfo(msgData),
								changeType: change.type,
							};
						}
						return {
							message: { id: msgData.id },
							changeType: change.type,
						};
					})
				);
				snapshots.reverse().forEach(snap => {
					if (snap.changeType === 'added') {
						messagesStore.addMessage(snap.message, 'end');
					} else if (snap.changeType === 'modified') {
						messagesStore.modifyMessage(snap.message);
					} else {
						// messagesStore.deleteMessageById(snap.message.id);
					}
				});
				if (messagesRef.size >= lmt) {
					messagesStore.lastVisible.top = messagesRef.docs[messagesRef.docs.length - 1];
				}
			} catch (err) {
				return errorHandler(err);
			} finally {
				if (messagesStore.isLoadingFirst) {
					messagesStore.setFirstLoading(false);
				}
			}
		});
	}

	static async loadMoreMessages(chatId: ChatInfo['id'], direction: Direction, perPage: number = 10) {
		const messagesStore = useMessagesStore();
		if (messagesStore.lastVisible[direction] && !messagesStore.isLoading) {
			try {
				messagesStore.isLoading = true;
				const messagesCol = this.getMessagesCol(chatId);
				const q = query(
					messagesCol,
					orderBy('created_at', direction === 'top' ? 'desc' : 'asc'),
					startAfter(messagesStore.lastVisible[direction]),
					limit(perPage)
				);
				const messagesRef = await getDocs(q);
				if (messagesRef.empty) {
					messagesStore.lastVisible[direction] = null;
					return;
				}
				// if (messages.value.length > 40) {
				// 	deleteMessages(perPage, direction === 'top' ? 'end' : 'start');
				// 	const msgBeforeDel = await getDoc(doc(messagesCol, messages.value.at(direction === 'top' ? -1 : 0)?.id));
				// 	lastVisible.value[direction === 'top' ? 'bottom' : 'top'] = msgBeforeDel as LastVisibleFbRef[Direction];
				// }

				const messages = await Promise.all(
					messagesRef.docs.map(async doc => {
						const message = await this.getFullMessageInfo(doc.data());
						return message;
					})
				);
				for (const m of messages) {
					messagesStore.addMessage(m, direction === 'top' ? 'start' : 'end');
				}

				messagesStore.lastVisible[direction] =
					messagesRef.size >= perPage ? messagesRef.docs[messagesRef.docs.length - 1] : null;
			} catch (e) {
				return errorHandler(e);
			} finally {
				messagesStore.isLoading = false;
			}
		}
	}

	private static async getFullMessageInfo(dbMessage: MessageWithId) {
		try {
			const senderInfo = (await UserService.getUserDisplayInfo(dbMessage.sender.id))!;
			const message = {
				...dbMessage,
				sender: senderInfo,
			} as Message;

			if (dbMessage.content.type !== 'text' && dbMessage.content.attachments?.length) {
				const attachmentsWithThumb = await Promise.all(
					dbMessage.content.attachments.map(async file => {
						if (file.thumbnail) {
							return {
								...file,
								thumbnail: await MessagesService.getMessageThumb(file.thumbnail.fullpath, file.fileType),
							} as MessageAttachment<AttachmentType>;
						}
						return file as MessageAttachment<'file'>;
					})
				);
				(message.content as MessageContent<AttachmentType>).attachments = attachmentsWithThumb;
			}
			return message;
		} catch (e) {
			return errorHandler(e);
		}
	}

	private static async getMessageThumb(path: string, fileType: DBMessageAttachment['fileType']) {
		try {
			const buffer = await getBytes(storageRef(storage, path));
			return `data:${fileType};base64,${encode(buffer)}`;
		} catch (e) {
			return errorHandler(e);
		}
	}

	static async loadPreviewbyFullpath(path: string) {
		try {
			const blobFile = await getBlob(storageRef(storage, path));
			return URL.createObjectURL(blobFile);
		} catch (e) {
			return errorHandler(e);
		}
	}

	static async createMessage(chatId: ChatInfo['id'], content: CreateMsgForm) {
		try {
			const newMessageRef = doc(this.getMessagesCol(chatId));
			const { attachments, ...msgContent } = content;

			const messageContent: DBMessageContent = msgContent;

			// Get images thumbs and Doc ref to prospective image upload
			if (attachments && attachments.length) {
				messageContent.attachments = await this.uploadAttachments(chatId, newMessageRef, attachments);
			}
			// Add full message data to DB
			await setDoc(newMessageRef, {
				id: newMessageRef.id,
				content: messageContent,
				sender: UserService.getUserDocRef(await AuthService.getUid()),
				created_at: Timestamp.now(),
				updated_at: null,
			});
		} catch (e) {
			return errorHandler(e);
		}
	}

	static async updateMessage(chatId: ChatInfo['id'], { id: mId, content }: EditMessageData) {
		try {
			const messageDocRef = this.getMessageDocRef(chatId, mId);
			// Rewrite text content data to DB
			return updateDoc(messageDocRef, {
				'content.text': content.text,
				updated_at: Timestamp.now(),
			} as UpdateData<DBMessage>);
		} catch (e) {
			errorHandler(e);
		}
	}

	private static async createUploadTask(
		chatId: ChatInfo['id'],
		messageDocRef: DocumentReference<MessageWithId>,
		file: FormAttachment,
		DBcontentToUpdate: Partial<DBMessageAttachment>
	) {
		const { setUploading, updateLoading, finishLoading } = useLoadingStore();
		const { fileData, id: fileId } = file;
		const fileDocRef = storageRef(
			storage,
			`chats/${chatId}/messageData/${messageDocRef.id}/${fileId + '.' + fileData.name.split('.').slice(1).join('.')}`
		);
		const uploadTask = uploadBytesResumable(fileDocRef, fileData, {
			contentType: fileData.type,
		});
		setUploading(fileId, uploadTask);
		uploadTask.on(
			'state_changed',
			snapshot => {
				// Observe state change events such as progress, pause, and resume
				// Get task progress, including the number of bytes uploaded and the total number of bytes to be uploaded
				const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
				updateLoading(fileId, progress);
				switch (snapshot.state) {
					case 'paused':
						console.log('Upload is paused');
						break;
					case 'running':
						console.log('Upload is running');
						break;
				}
			},
			async error => {
				try {
					finishLoading(fileId);
					// Handle unsuccessful uploads
					await deleteDoc(messageDocRef);
					await deleteObject(storageRef(storage, DBcontentToUpdate.thumbnail?.fullpath));
					switch (error.code) {
						case 'storage/unauthorized':
							// User doesn't have permission to access the object
							break;
						case 'storage/canceled':
							// User canceled the upload
							break;
						case 'storage/unknown':
							// Unknown error occurred, inspect error.serverResponse
							break;
					}
					throw error;
				} catch (e) {
					console.error(e);
				}
			},
			async () => {
				try {
					// Handle successful uploads on complete
					const raw = {
						bucket: uploadTask.snapshot.ref.bucket,
						fullpath: uploadTask.snapshot.ref.fullPath,
						fullsize: fileData.size,
					} as DBMessageAttachment['raw'];
					if ((file as FormAttachment<'media'>).sizes) {
						raw.sizes = (file as FormAttachment<'media'>).sizes;
					}
					await writeBatch(db)
						.update(messageDocRef, {
							'content.attachments': arrayRemove(DBcontentToUpdate),
						} as UpdateData<DBMessageAttachment>)
						.update(messageDocRef, {
							'content.attachments': arrayUnion({
								...DBcontentToUpdate,
								raw,
							}),
						} as UpdateData<DBMessageAttachment>)
						.commit();
					finishLoading(fileId);
				} catch (e) {
					return errorHandler(e);
				}
			}
		);
	}

	private static async uploadThumb(chatId: ChatInfo['id'], messageId: Message['id'], attach: FormAttachment<'media'>) {
		try {
			if (attach.thumbnail) {
				const { fileData, id, thumbnail } = attach;
				const thumbRef = storageRef(
					storage,
					`chats/${chatId}/messageData/${messageId}/${
						id + '_thumb.' + fileData.name.split('.').slice(1).join('.')
					}`
				);
				await uploadString(thumbRef, thumbnail.url, 'data_url');
				return {
					bucket: thumbRef.bucket,
					fullpath: thumbRef.fullPath,
					fullsize: thumbnail.fullsize,
				} as DBMessageAttachment['thumbnail'];
			}
		} catch (e) {
			return errorHandler(e);
		}
	}

	private static async uploadAttachments(
		chatId: ChatInfo['id'],
		messageDocRef: DocumentReference<MessageWithId>,
		attach: FormAttachment[]
	) {
		try {
			if (!attach.every(file => file.fileData instanceof File)) {
				throw new Error('Attachments should be instance of file');
			}
			const attachResult = await Promise.all(
				attach.map(async file => {
					const { fileData, id, thumbnail, sizes } = file as FormAttachment<'media'>;
					const attachContent: DBMessageAttachment = {
						id,
						fileType: fileData.type,
						fullname: fileData.name,
						raw: { sizes, fullsize: fileData.size },
					} as DBMessageAttachment & { raw: Partial<DBMessageAttachment['raw']> };
					if (file.fileData.type.startsWith('image/') && sizes && thumbnail) {
						const thumbData = await this.uploadThumb(chatId, messageDocRef.id, file as FormAttachment<'media'>);
						if (thumbData) {
							attachContent.thumbnail = thumbData;
						}
					}
					this.createUploadTask(chatId, messageDocRef, file, attachContent);
					return attachContent;
				})
			);
			return attachResult;
		} catch (e) {
			return errorHandler(e);
		}
	}

	static async deleteMessageById(chatId: ChatInfo['id'], mId: Message['id']) {
		const messageDocRef = this.getMessageDocRef(chatId, mId);
		return deleteDoc(messageDocRef).catch(err => errorHandler(err));
	}
}
